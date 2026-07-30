// Route-level unit tests for GET /api/auth/jellyfin/servers
// (src/app/api/auth/jellyfin/servers/route.ts) — the PUBLIC (proxy-exempt via
// isPublicPath's `/api/auth/` prefix) Jellyfin sign-in server picker that native
// clients fetch BEFORE sign-in, because they can't call
// getSyncableMediaInstances() from a server component the way the web login page
// does.
//
// Pinned here:
//   * the EXACT wire contract { servers: [{ slug, name }] } — an exhaustive key
//     assertion on every element, because this is an unauthenticated surface and
//     field creep (a server URL, an API key, the registry's `restricted` flag) is
//     the standing risk. The registry hands the route a MediaInstanceConfig that
//     genuinely carries `restricted`, so the projection is load-bearing, not
//     incidental;
//   * default ("") first, so a client defaulting to servers[0] lands on the
//     default server;
//   * ONLY fully-configured instances are offered (URL *and* API key present) —
//     the same gate src/app/login/page.tsx applies. A registered instance with a
//     missing API key must never appear, or the picker offers an option that can
//     only ever fail to authenticate;
//   * Jellyfin unconfigured ⇒ { servers: [] } with 200, NOT a 404 — the client
//     reads an empty list as "no Jellyfin sign-in available";
//   * no authentication of any kind is required (no cookie, no bearer ⇒ 200);
//   * the per-IP rate cap 429s past its budget, with setup-status's body shape.
//     compat can go uncapped because it's DB-free; this route reads the registry
//     Setting plus per-instance connection rows, so it needs the cap.
//
// Owned elsewhere, asserted only at the seam: the registry's parsing/dedup/
// normalization rules and the key derivation (media-instance-registry /
// media-instances tests), getClientIp + the sliding window (rate-limit tests).
//
// No DB and no network: globalThis.prisma is pre-seeded with an in-memory
// Setting fake BEFORE the module graph loads (the public-routes / auth-routes
// idiom, so prisma.ts hands the fake back un-extended), and fetch throws.
// TRUST_PROXY=true lets each request carry a unique X-Forwarded-For so its
// rate-limit bucket never collides with another test's.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomInt } from "node:crypto";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // prisma.ts pulls in token-crypto
process.env.TRUST_PROXY = "true"; // per-request X-Forwarded-For → isolated rate-limit buckets
delete process.env.TRUSTED_PROXY_HOPS;

// ── console capture (guardrail 7: no happy-path logging) ────────────────────
const warns: string[] = [];
const errors: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

// ── no network, ever ────────────────────────────────────────────────────────
globalThis.fetch = (() => {
  throw new Error("unexpected network call from jellyfin-servers route tests");
}) as unknown as typeof fetch;

// ── in-memory Setting table ─────────────────────────────────────────────────
const settings = new Map<string, string>();
let settingReads = 0;

const fakePrisma = {
  setting: {
    findUnique: async (args: { where: { key: string } }) => {
      settingReads++;
      const value = settings.get(args.where.key);
      return value === undefined ? null : { key: args.where.key, value };
    },
    findMany: async (args: { where: { key: { in: string[] } } }) => {
      settingReads++;
      return args.where.key.in
        .filter((k) => settings.has(k))
        .map((k) => ({ key: k, value: settings.get(k) as string }));
    },
  },
};
(globalThis as unknown as { prisma: unknown }).prisma = fakePrisma;

// Dynamic imports so the env/global stubs above genuinely precede the module
// graph (static imports would hoist past them).
const { NextRequest } = await import("next/server");
const { checkRateLimit } = await import("../src/lib/rate-limit.ts");
const { GET: serversGet } = await import("../src/app/api/auth/jellyfin/servers/route.ts");

type Req = InstanceType<typeof NextRequest>;

// ── fixtures / helpers ──────────────────────────────────────────────────────

// A fresh public-shaped IPv4 per request so each rate-limit bucket
// (jellyfin-servers:<ip>) is isolated across tests.
//
// The prefix is RANDOM PER RUN, not a fixed 203.0.x.y sequence: rate-limit.ts's
// window map is module-level with no reset hook, so beforeEach cannot clear it.
// With deterministic addresses anything else that shares this process — another
// suite minting test IPs the same way, or a rerun in a single-process runner —
// pre-consumes these exact buckets and every test 429s. Randomizing the two
// middle octets makes the buckets unguessable and effectively collision-free,
// and the exhaustion guard turns a silent reuse into a loud failure.
const IP_RUN_PREFIX = `203.${1 + randomInt(250)}.${1 + randomInt(250)}`;
let ipSeq = 0;
function freshIp(): string {
  ipSeq++;
  if (ipSeq > 250) throw new Error("freshIp() exhausted its per-run address space — widen the prefix");
  return `${IP_RUN_PREFIX}.${ipSeq}`;
}

function serversReq(ip: string = freshIp(), headers: Record<string, string> = {}): Req {
  return new NextRequest("http://localhost:3000/api/auth/jellyfin/servers", {
    method: "GET",
    headers: { "x-forwarded-for": ip, ...headers },
  });
}

async function bodyOf(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

// Register named instances in the registry Setting (the default "" instance is
// synthesized by the registry and is never stored here).
function registerInstances(entries: Array<{ slug: string; name: string; restricted?: boolean }>): void {
  settings.set(
    "jellyfinInstances",
    JSON.stringify(entries.map((e) => ({ slug: e.slug, name: e.name, restricted: e.restricted === true }))),
  );
}

// Write an instance's connection rows. Omitting either half models a
// half-configured instance (exactly what must be filtered out).
function configureInstance(slug: string, opts: { url?: string; apiKey?: string }): void {
  const seg = slug === "" ? "" : slug.charAt(0).toUpperCase() + slug.slice(1);
  if (opts.url !== undefined) settings.set(`jellyfin${seg}Url`, opts.url);
  if (opts.apiKey !== undefined) settings.set(`jellyfin${seg}ApiKey`, opts.apiKey);
}

async function serversOf(res: Response): Promise<Array<Record<string, unknown>>> {
  const body = await bodyOf(res);
  assert.deepEqual(Object.keys(body), ["servers"], "the envelope must carry exactly one key: servers");
  assert.ok(Array.isArray(body.servers), "servers must be an array");
  return body.servers as Array<Record<string, unknown>>;
}

beforeEach(() => {
  warns.length = 0;
  errors.length = 0;
  settings.clear();
  settingReads = 0;
});

// ── happy path ──────────────────────────────────────────────────────────────

// The four pins below are deliberately SEPARATE tests. An exhaustive
// `assert.deepEqual` (node:assert/strict ⇒ deepStrictEqual) already rejects
// extra keys, missing keys and wrong order, so any narrower assertion written
// underneath one is dead code — it can never be the assertion that reports a
// regression, and it silently stops protecting anything the day someone
// loosens the deepEqual to a subset match. Each named pin therefore gets its
// own test, with nothing stricter above it.

test("two configured instances → both returned, in exactly the { slug, name } shape", async () => {
  registerInstances([{ slug: "remote", name: "Friend's" }]);
  configureInstance("", { url: "http://jf.local:8096", apiKey: "default-key" });
  configureInstance("remote", { url: "http://remote.example:8096", apiKey: "remote-key" });

  const res = await serversGet(serversReq());
  assert.equal(res.status, 200);

  assert.deepEqual(await serversOf(res), [
    { slug: "", name: "Default" },
    { slug: "remote", name: "Friend's" },
  ]);
});

test("the DEFAULT instance is listed FIRST", async () => {
  // Order is contractual, not incidental: a client defaulting to servers[0]
  // must land on the default server. Three instances so a reversal is visible
  // (with two, several wrong orderings coincide with the right one).
  registerInstances([
    { slug: "aaa", name: "Alpha" },
    { slug: "remote", name: "Friend's" },
  ]);
  configureInstance("", { url: "http://jf.local:8096", apiKey: "k" });
  configureInstance("aaa", { url: "http://alpha.example:8096", apiKey: "k" });
  configureInstance("remote", { url: "http://remote.example:8096", apiKey: "k" });

  // Slugs only — the shape and the values are pinned above, so this test fails
  // for exactly one reason.
  const servers = await serversOf(await serversGet(serversReq()));
  assert.deepEqual(servers.map((s) => s.slug), ["", "aaa", "remote"]);
});

test("every element carries EXACTLY { slug, name } — no registry internals reach an unauthenticated caller", async () => {
  // The route is handed a MediaInstanceConfig that genuinely carries
  // `restricted`, so the projection is load-bearing, not incidental: it is what
  // stops that field — and anything later added to the interface — from
  // reaching a caller with no session. No URLs, no API keys, no counts.
  registerInstances([{ slug: "remote", name: "Friend's", restricted: true }]);
  configureInstance("", { url: "http://jf.local:8096", apiKey: "default-key" });
  configureInstance("remote", { url: "http://remote.example:8096", apiKey: "remote-key" });

  const servers = await serversOf(await serversGet(serversReq()));
  assert.equal(servers.length, 2, "both instances must be present, or the key scan below inspects nothing");
  for (const s of servers) {
    assert.deepEqual(Object.keys(s).sort(), ["name", "slug"], `unexpected keys on ${JSON.stringify(s)}`);
    assert.equal(typeof s.slug, "string");
    assert.equal(typeof s.name, "string");
  }
});

test("nothing secret appears anywhere in the RAW response body", async () => {
  registerInstances([{ slug: "remote", name: "Friend's", restricted: true }]);
  configureInstance("", { url: "http://jf.local:8096", apiKey: "default-key" });
  configureInstance("remote", { url: "http://remote.example:8096", apiKey: "remote-key" });

  // Deliberately unparsed: scanning the bytes the route actually serialized —
  // rather than a literal some earlier assertion already pinned — is what makes
  // this survive a future response shape no assertion in this file describes.
  const raw = await (await serversGet(serversReq())).text();
  for (const secret of ["default-key", "remote-key", "jf.local", "remote.example", "restricted"]) {
    assert.ok(!raw.includes(secret), `the response leaked "${secret}" — body was ${raw}`);
  }
});

test("a restricted named instance is still offered for SIGN-IN, and its restricted flag is not echoed", async () => {
  // `restricted` gates per-user LIBRARY visibility, not authentication — a user
  // whose account lives on that server must still be able to sign in.
  registerInstances([{ slug: "remote", name: "Friend's", restricted: true }]);
  configureInstance("", { url: "http://jf.local:8096", apiKey: "k" });
  configureInstance("remote", { url: "http://remote.example:8096", apiKey: "k2" });

  const servers = await serversOf(await serversGet(serversReq()));
  assert.deepEqual(servers, [
    { slug: "", name: "Default" },
    { slug: "remote", name: "Friend's" },
  ]);
});

// ── configured-only filtering ───────────────────────────────────────────────

test("an instance registered but NOT fully configured (missing API key) is EXCLUDED", async () => {
  registerInstances([{ slug: "remote", name: "Friend's" }]);
  configureInstance("", { url: "http://jf.local:8096", apiKey: "default-key" });
  configureInstance("remote", { url: "http://remote.example:8096" }); // no API key

  const servers = await serversOf(await serversGet(serversReq()));
  // Offering it would put an option in the picker that can only ever fail to
  // authenticate — the exact reason the route uses getSyncableMediaInstances
  // rather than getMediaInstances.
  assert.deepEqual(servers, [{ slug: "", name: "Default" }]);
});

test("a missing URL, and a whitespace-only credential, are both EXCLUDED (trimmed presence, not truthiness)", async () => {
  registerInstances([
    { slug: "nourl", name: "No URL" },
    { slug: "blank", name: "Blank Key" },
    { slug: "good", name: "Good" },
  ]);
  configureInstance("", { url: "http://jf.local:8096", apiKey: "k" });
  configureInstance("nourl", { apiKey: "k" }); // key without URL
  configureInstance("blank", { url: "http://blank.example:8096", apiKey: "   " });
  configureInstance("good", { url: "http://good.example:8096", apiKey: "k" });

  const servers = await serversOf(await serversGet(serversReq()));
  assert.deepEqual(servers, [
    { slug: "", name: "Default" },
    { slug: "good", name: "Good" },
  ]);
});

test("the DEFAULT instance is excluded too when unconfigured — only named servers are offered", async () => {
  // A deployment whose only Jellyfin is a named server: nothing about "" is
  // special-cased into the list, it earns its slot by being configured.
  registerInstances([{ slug: "remote", name: "Friend's" }]);
  configureInstance("remote", { url: "http://remote.example:8096", apiKey: "remote-key" });

  const servers = await serversOf(await serversGet(serversReq()));
  assert.deepEqual(servers, [{ slug: "remote", name: "Friend's" }]);
});

// ── unconfigured ⇒ empty list, 200 ──────────────────────────────────────────

test("Jellyfin not configured at all → { servers: [] } with 200, NOT 404", async () => {
  const res = await serversGet(serversReq());
  assert.equal(res.status, 200, "an empty list is a normal answer, not an error the client must special-case");
  assert.deepEqual(await bodyOf(res), { servers: [] });
});

test("a registry Setting present but every instance unconfigured → { servers: [] } with 200", async () => {
  registerInstances([{ slug: "remote", name: "Friend's" }]);
  const res = await serversGet(serversReq());
  assert.equal(res.status, 200);
  assert.deepEqual(await bodyOf(res), { servers: [] });
});

test("a corrupt registry JSON blob degrades to the default instance rather than throwing", async () => {
  settings.set("jellyfinInstances", "{not json");
  configureInstance("", { url: "http://jf.local:8096", apiKey: "k" });

  const res = await serversGet(serversReq());
  assert.equal(res.status, 200);
  assert.deepEqual(await bodyOf(res), { servers: [{ slug: "", name: "Default" }] });
});

// ── public: no authentication required ──────────────────────────────────────

test("no session and no bearer → still 200 (public by design; consumed BEFORE sign-in)", async () => {
  configureInstance("", { url: "http://jf.local:8096", apiKey: "k" });

  // Bare request: no cookie header, no Authorization header at all.
  const anonymous = await serversGet(serversReq());
  assert.equal(anonymous.status, 200);
  assert.deepEqual(await bodyOf(anonymous), { servers: [{ slug: "", name: "Default" }] });

  // A garbage bearer / garbage session cookie must not turn a public route into
  // a 401 either — there is no auth material to reject.
  const garbage = await serversGet(
    serversReq(freshIp(), {
      authorization: "Bearer not-a-real-jwt",
      cookie: "summonarr-session=not-a-real-jwt",
    }),
  );
  assert.equal(garbage.status, 200);
  assert.deepEqual(await bodyOf(garbage), { servers: [{ slug: "", name: "Default" }] });
});

// ── rate limit ──────────────────────────────────────────────────────────────

test("the per-IP probe rate is capped (429) — this route reads the DB, unlike compat", async () => {
  configureInstance("", { url: "http://jf.local:8096", apiKey: "k" });
  const ip = freshIp();

  // Burn the budget through the shared limiter, then prove the route refuses.
  for (let i = 0; i < 30; i++) checkRateLimit(`jellyfin-servers:${ip}`, 30, 60_000);

  const readsBefore = settingReads;
  const limited = await serversGet(serversReq(ip));
  assert.equal(limited.status, 429);
  assert.deepEqual(await bodyOf(limited), { error: "Too many requests" });
  // The whole point of the cap is that an over-budget caller can't amplify load,
  // so the rejection must happen BEFORE any Setting read.
  assert.equal(settingReads, readsBefore, "a rate-limited request must not touch the DB");

  // The cap is per-IP: another caller is unaffected.
  const other = await serversGet(serversReq(freshIp()));
  assert.equal(other.status, 200);
});

test("guardrail 7: the happy path logs nothing", async () => {
  configureInstance("", { url: "http://jf.local:8096", apiKey: "k" });
  await serversGet(serversReq());
  assert.deepEqual(warns, []);
  assert.deepEqual(errors, []);
});
