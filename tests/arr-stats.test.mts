// Unit tests for the per-instance disk-space aggregator (src/lib/arr-stats.ts),
// which feeds the admin stats dashboard AND is serialized to native clients.
// The contracts pinned here:
//   - the ArrDiskSpace envelope keeps its back-compat shape: `radarr`/`sonarr`
//     carry the DEFAULT instance's entries (null when that instance isn't
//     configured), and every non-default instance (legacy 4K, named) rides the
//     additive `extra` array — older consumers must be able to ignore it;
//   - each syncable instance is fetched from ITS OWN base url at exactly
//     <url>/api/v3/diskspace with ITS OWN X-Api-Key (cross-instance credential
//     isolation), the config-layer trailing-slash strip included;
//   - `extra` entries carry {service, slug, label} with the display label
//     derived from the instance name — "Radarr (4K)" for the synthesized
//     legacy 4K instance, "Radarr (<name>)" for named ones — ordered radarr
//     instances first, then sonarr, in registry order (4K spliced after the
//     default);
//   - a registered-but-unconfigured instance is skipped entirely (no fetch);
//   - one failing instance DEGRADES to null/omitted instead of sinking the
//     whole result: an upstream HTTP error (ArrResponseError) is silent at
//     this layer (arrFetch already logs it), while a transport-level failure
//     warns with the [arr-stats] scope — both leave the other instances'
//     results intact.
//
// arr-stats sits on top of arr.ts getArrCfg (Setting reads) + arrFetch
// (safeFetchAdminConfigured) and arr-instance-registry (registry JSON +
// configured-keys probes). Registry parsing itself is covered by
// tests/arr-instance-registry.test.mts and is NOT re-tested here — the
// registry is plumbing for these tests. No DB or network: prisma.setting is
// shadowed in-memory (tests/_helpers.mts) and globalThis.fetch is scripted
// per URL. Instance urls use RFC1918 IP literals so the admin-mode SSRF
// resolver (allowPrivate=true) short-circuits without DNS; dns/promises.lookup
// is stubbed anyway as a belt-and-braces guard. Bypassing the Setting crypto
// extension is faithful: it decrypts sensitive keys (radarr*ApiKey) on read,
// so production callers see plaintext exactly like the stub returns.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // prisma.ts pulls in token-crypto

// ── DNS stub (defensive — IP-literal hosts never reach it) ──────────────────
const fakeLookup = async () => [{ address: "192.168.1.99", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) {
  throw new Error("could not stub dns.lookup — aborting before a real DNS query can leave the process");
}

// ── console capture ─────────────────────────────────────────────────────────
const warns: string[] = [];
const errors: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

// Dynamic imports so the stubs above genuinely precede the module-graph load
// (static imports would hoist above them — the trakt.test pattern).
const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel } = await import("./_helpers.mts");
const { getArrDiskSpace } = await import("../src/lib/arr-stats.ts");

// ── prisma stub ─────────────────────────────────────────────────────────────
// One Setting map serves every reader in the stack: the registry JSON
// (findUnique), isInstanceConfigured's url/apiKey presence probe (findMany),
// and getCfg's url/apiKey/rootFolder/profile read (findMany).
const settings = new Map<string, string>();
shadowPrismaModel(prisma, "setting", {
  findUnique: async (args: { where: { key: string } }) => {
    const v = settings.get(args.where.key);
    return v !== undefined ? { key: args.where.key, value: v } : null;
  },
  findMany: async (args: { where: { key: { in: string[] } } }) =>
    args.where.key.in
      .filter((k) => settings.has(k))
      .map((k) => ({ key: k, value: settings.get(k) })),
});

// ── scripted fetch ──────────────────────────────────────────────────────────
type FetchCall = { url: string; apiKey: string | null };
const fetchCalls: FetchCall[] = [];
// Responders keyed by URL origin — each instance lives on its own host:port.
const respondByOrigin = new Map<string, (url: URL) => Response>();
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  fetchCalls.push({ url: url.toString(), apiKey: new Headers(init?.headers).get("x-api-key") });
  const responder = respondByOrigin.get(url.origin);
  if (!responder) throw new TypeError(`unexpected fetch to ${url.origin} — script a responder`);
  return responder(url);
}) as typeof fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// One DiskSpaceEntry fixture per instance so passthrough is provable per host.
type Entry = { path: string; label: string; freeSpace: number; totalSpace: number };
function entriesFor(name: string): Entry[] {
  return [
    { path: `/mnt/${name}`, label: name, freeSpace: 111_222_333_444, totalSpace: 999_888_777_666 },
    { path: `/mnt/${name}-overflow`, label: `${name}-overflow`, freeSpace: 5, totalSpace: 10 },
  ];
}

const RADARR_URL = "http://192.168.1.10:7878";
const RADARR_4K_URL = "http://192.168.1.11:7878";
const RADARR_ANIME_URL = "http://192.168.1.12:7878";
const SONARR_URL = "http://192.168.1.20:8989";
const SONARR_ANIME_URL = "http://192.168.1.21:8989";

function configureInstance(prefix: string, url: string, apiKey: string, entries: Entry[] | null): void {
  settings.set(`${prefix}Url`, url);
  settings.set(`${prefix}ApiKey`, apiKey);
  if (entries) respondByOrigin.set(new URL(url).origin, () => jsonResponse(entries));
}

beforeEach(() => {
  settings.clear();
  respondByOrigin.clear();
  fetchCalls.length = 0;
  warns.length = 0;
  errors.length = 0;
});

// ── tests ───────────────────────────────────────────────────────────────────

test("nothing configured → { radarr: null, sonarr: null, extra: [] } with zero fetches", async () => {
  assert.deepEqual(await getArrDiskSpace(), { radarr: null, sonarr: null, extra: [] });
  assert.equal(fetchCalls.length, 0);
});

test("default radarr+sonarr: entries pass through verbatim on the back-compat fields, exact endpoint per service", async () => {
  const radarrEntries = entriesFor("movies");
  const sonarrEntries = entriesFor("tv");
  // Trailing slash on the stored url — getCfg strips it, so the wire URL has
  // no double slash.
  configureInstance("radarr", `${RADARR_URL}/`, "radarr-key", null);
  respondByOrigin.set(new URL(RADARR_URL).origin, () => jsonResponse(radarrEntries));
  configureInstance("sonarr", SONARR_URL, "sonarr-key", sonarrEntries);

  const result = await getArrDiskSpace();
  assert.deepEqual(result, { radarr: radarrEntries, sonarr: sonarrEntries, extra: [] });

  const urls = fetchCalls.map((c) => c.url).sort();
  assert.deepEqual(urls, [
    `${RADARR_URL}/api/v3/diskspace`,
    `${SONARR_URL}/api/v3/diskspace`,
  ]);
});

test("each instance is called with its OWN X-Api-Key on its OWN host (credential isolation)", async () => {
  configureInstance("radarr", RADARR_URL, "default-radarr-key", entriesFor("movies"));
  settings.set("arrRadarrInstances", JSON.stringify([{ slug: "anime", name: "Anime" }]));
  configureInstance("radarrAnime", RADARR_ANIME_URL, "anime-radarr-key", entriesFor("anime"));

  await getArrDiskSpace();
  const byOrigin = new Map(fetchCalls.map((c) => [new URL(c.url).origin, c.apiKey]));
  assert.equal(byOrigin.get(new URL(RADARR_URL).origin), "default-radarr-key");
  assert.equal(byOrigin.get(new URL(RADARR_ANIME_URL).origin), "anime-radarr-key");
});

test("default radarr unconfigured → radarr null with no fetch attempt; sonarr unaffected", async () => {
  configureInstance("sonarr", SONARR_URL, "sonarr-key", entriesFor("tv"));
  const result = await getArrDiskSpace();
  assert.equal(result.radarr, null);
  assert.deepEqual(result.sonarr, entriesFor("tv"));
  assert.equal(fetchCalls.length, 1); // only sonarr was contacted
  assert.equal(new URL(fetchCalls[0].url).origin, new URL(SONARR_URL).origin);
});

test("legacy 4K instance (configured, no registry row) rides `extra` as slug '4k' / label 'Radarr (4K)'", async () => {
  configureInstance("radarr", RADARR_URL, "radarr-key", entriesFor("movies"));
  configureInstance("radarr4k", RADARR_4K_URL, "radarr-4k-key", entriesFor("movies-4k"));

  const result = await getArrDiskSpace();
  assert.deepEqual(result.radarr, entriesFor("movies")); // default stays on the back-compat field
  assert.deepEqual(result.extra, [
    { service: "radarr", slug: "4k", label: "Radarr (4K)", entries: entriesFor("movies-4k") },
  ]);
});

test("named instances use the registry display name in the label — 'Sonarr (Anime Shows)'", async () => {
  configureInstance("sonarr", SONARR_URL, "sonarr-key", entriesFor("tv"));
  settings.set("arrSonarrInstances", JSON.stringify([{ slug: "anime", name: "Anime Shows" }]));
  configureInstance("sonarrAnime", SONARR_ANIME_URL, "sonarr-anime-key", entriesFor("anime-tv"));

  const result = await getArrDiskSpace();
  assert.deepEqual(result.extra, [
    { service: "sonarr", slug: "anime", label: "Sonarr (Anime Shows)", entries: entriesFor("anime-tv") },
  ]);
});

test("`extra` is ordered radarr-then-sonarr, 4K spliced right after the default within a service", async () => {
  configureInstance("radarr", RADARR_URL, "rk", entriesFor("movies"));
  configureInstance("radarr4k", RADARR_4K_URL, "rk4", entriesFor("movies-4k"));
  settings.set("arrRadarrInstances", JSON.stringify([{ slug: "anime", name: "Anime" }]));
  configureInstance("radarrAnime", RADARR_ANIME_URL, "rka", entriesFor("anime"));
  configureInstance("sonarr", SONARR_URL, "sk", entriesFor("tv"));
  settings.set("arrSonarrInstances", JSON.stringify([{ slug: "anime", name: "Anime" }]));
  configureInstance("sonarrAnime", SONARR_ANIME_URL, "ska", entriesFor("anime-tv"));

  const result = await getArrDiskSpace();
  assert.deepEqual(
    result.extra.map((e) => [e.service, e.slug]),
    [["radarr", "4k"], ["radarr", "anime"], ["sonarr", "anime"]],
  );
});

test("a registered-but-unconfigured instance is skipped without a fetch and absent from `extra`", async () => {
  configureInstance("radarr", RADARR_URL, "rk", entriesFor("movies"));
  settings.set("arrRadarrInstances", JSON.stringify([{ slug: "kids", name: "Kids" }]));
  // no radarrKidsUrl / radarrKidsApiKey configured

  const result = await getArrDiskSpace();
  assert.deepEqual(result.extra, []);
  assert.equal(fetchCalls.length, 1); // only the default instance was contacted
});

test("an upstream HTTP error on one instance degrades just that instance — silently at this layer", async () => {
  configureInstance("radarr", RADARR_URL, "rk", entriesFor("movies"));
  settings.set("arrRadarrInstances", JSON.stringify([{ slug: "anime", name: "Anime" }]));
  configureInstance("radarrAnime", RADARR_ANIME_URL, "rka", null);
  respondByOrigin.set(new URL(RADARR_ANIME_URL).origin, () => jsonResponse({ message: "boom" }, 500));
  configureInstance("sonarr", SONARR_URL, "sk", entriesFor("tv"));

  const result = await getArrDiskSpace();
  assert.deepEqual(result.radarr, entriesFor("movies"));
  assert.deepEqual(result.sonarr, entriesFor("tv"));
  assert.deepEqual(result.extra, []); // failed anime dropped, not a null placeholder
  // arrFetch already logged the non-2xx; arr-stats must not double-report it.
  assert.ok(errors.some((e) => e.includes("[arr]") && e.includes("500")));
  assert.equal(warns.filter((w) => w.includes("[arr-stats]")).length, 0);
});

test("a transport-level failure degrades the instance AND warns with the [arr-stats] scope", async () => {
  // Default radarr's socket dies (no responder scripted → the fetch throws, and
  // safe-fetch surfaces it as a SafeFetchError — not an ArrResponseError).
  configureInstance("radarr", RADARR_URL, "rk", null);
  configureInstance("sonarr", SONARR_URL, "sk", entriesFor("tv"));

  const result = await getArrDiskSpace();
  assert.equal(result.radarr, null);
  assert.deepEqual(result.sonarr, entriesFor("tv")); // the healthy service survives
  assert.ok(
    warns.some((w) => w.includes("[arr-stats] radarr diskspace failed")),
    "transport failures must be attributed to the instance in the warn",
  );
});
