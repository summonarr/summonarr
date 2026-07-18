// Unit tests for the ipinfo.io geolocation resolver (src/lib/ip-lookup.ts),
// which backs the location column/tooltips on the admin activity + sessions
// surfaces. The contracts pinned here:
//   - garbage input (non-IP, empty, whitespace) → null before ANY DB read;
//   - private/reserved addresses (RFC1918, loopback, link-local, CGNAT, 0.x,
//     multicast, IPv6 ::1/::/fe80:/fc../fd..) short-circuit to a bogon result
//     locally — no cache read, no token read, no network round-trip. The UI
//     labels these LAN; leaking them to ipinfo would be both a privacy leak
//     and a wasted quota hit;
//   - the IpLookupCache row is authoritative while fresh, with ASYMMETRIC
//     TTLs: found rows live 30 days, notFound rows only 24 hours (a bogon/
//     unknown verdict may heal, a city rarely moves) — both boundaries pinned;
//   - no configured token → cache-only mode: a stale row is still served, a
//     cold miss returns null, and the network is never touched;
//   - the fetch path issues EXACTLY https://ipinfo.io/<ip>/json?token=<enc>
//     (token is URI-encoded — it's admin-entered), upserts the parsed row
//     (loc "lat,lon" split, absent fields → null), and returns the upsert
//     result; upstream bogon:true is persisted as notFound:true with every
//     geo field nulled so a stale found-row can't shine through;
//   - upstream failure DEGRADES, never throws: HTTP non-2xx, a network error,
//     and an unparseable body all log with the [ip-lookup] scope and fall back
//     to the stale cached row (or null) — an activity page must render even
//     when ipinfo is down;
//   - testIpinfoConnection probes 8.8.8.8 and maps its four outcomes (no
//     token / HTTP error / malformed body / ok → org-or-ip).
//
// No DB or network: prisma.setting / prisma.ipLookupCache are shadowed
// in-memory (tests/_helpers.mts), globalThis.fetch is scripted per URL, and
// dns/promises.lookup is stubbed so safeFetchTrusted's SSRF resolver never
// issues a real lookup for ipinfo.io (see tests/omdb-quota.test.mts for the
// rationale). Bypassing the Setting crypto extension is faithful: it decrypts
// sensitive keys (ipinfoToken) on read, so production callers see plaintext
// exactly like the stub returns.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // prisma.ts pulls in token-crypto

// ── DNS stub ────────────────────────────────────────────────────────────────
const fakeLookup = async () => [{ address: "93.184.216.34", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) {
  throw new Error("could not stub dns.lookup — aborting before a real DNS query can leave the process");
}

// ── console capture ─────────────────────────────────────────────────────────
const errors: string[] = [];
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
console.warn = () => {};

// Dynamic imports so the stubs above genuinely precede the module-graph load
// (static imports would hoist above them — the trakt.test pattern).
const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel } = await import("./_helpers.mts");
const { getIpLookup, testIpinfoConnection } = await import("../src/lib/ip-lookup.ts");

// ── prisma stubs ────────────────────────────────────────────────────────────
let ipinfoToken: string | null = null;
let settingReads = 0;
shadowPrismaModel(prisma, "setting", {
  findUnique: async (args: { where: { key: string } }) => {
    settingReads++;
    return args.where.key === "ipinfoToken" && ipinfoToken !== null
      ? { key: "ipinfoToken", value: ipinfoToken }
      : null;
  },
});

// A stored row mirrors the IpLookupCache model: geo columns null-able, notFound
// defaults false, fetchedAt defaults now() on create. The upsert stub applies
// those defaults so rowToLookup sees real-DB shapes (null, never undefined).
type CacheRow = {
  ip: string;
  hostname: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  postal: string | null;
  latitude: number | null;
  longitude: number | null;
  timezone: string | null;
  org: string | null;
  notFound: boolean;
  fetchedAt: Date;
};
const EMPTY_GEO = {
  hostname: null, city: null, region: null, country: null, postal: null,
  latitude: null, longitude: null, timezone: null, org: null,
} as const;
const cacheRows = new Map<string, CacheRow>();
const cacheReads: string[] = [];
type UpsertArgs = { where: { ip: string }; create: Record<string, unknown>; update: Record<string, unknown> };
const upsertCalls: UpsertArgs[] = [];
shadowPrismaModel(prisma, "ipLookupCache", {
  findUnique: async (args: { where: { ip: string } }) => {
    cacheReads.push(args.where.ip);
    return cacheRows.get(args.where.ip) ?? null;
  },
  upsert: async (args: UpsertArgs) => {
    upsertCalls.push(args);
    const existing = cacheRows.get(args.where.ip);
    const row: CacheRow = existing
      ? ({ ...existing, ...args.update } as CacheRow)
      : ({ ...{ ip: args.where.ip, ...EMPTY_GEO, notFound: false, fetchedAt: new Date() }, ...args.create } as CacheRow);
    cacheRows.set(args.where.ip, row);
    return row;
  },
});

function seedRow(ip: string, ageMs: number, partial: Partial<CacheRow> = {}): void {
  cacheRows.set(ip, {
    ip, ...EMPTY_GEO, notFound: false,
    fetchedAt: new Date(Date.now() - ageMs),
    ...partial,
  });
}

// ── scripted fetch ──────────────────────────────────────────────────────────
const fetchCalls: string[] = [];
let respond: (url: URL) => Response = () => {
  throw new TypeError("unexpected fetch — script a responder for this test");
};
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(String(input));
  fetchCalls.push(url.toString());
  return respond(url);
}) as typeof fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(() => {
  ipinfoToken = null;
  settingReads = 0;
  cacheRows.clear();
  cacheReads.length = 0;
  upsertCalls.length = 0;
  fetchCalls.length = 0;
  errors.length = 0;
  respond = () => {
    throw new TypeError("unexpected fetch — script a responder for this test");
  };
});

// ── input validation + local bogon short-circuits ───────────────────────────

test("garbage input → null before any DB read", async () => {
  for (const input of ["", "   ", "not-an-ip", "999.1.2.3", "1.2.3", "8.8.8.8.8"]) {
    assert.equal(await getIpLookup(input), null, `input ${JSON.stringify(input)}`);
  }
  assert.equal(cacheReads.length, 0);
  assert.equal(settingReads, 0);
});

test("private/reserved IPv4 short-circuits to a full-shape bogon result with no DB or network", async () => {
  // One representative gets the exact-shape pin — the UI renders every field.
  assert.deepEqual(await getIpLookup("192.168.1.50"), {
    ip: "192.168.1.50", ...EMPTY_GEO, bogon: true,
  });
  // The whole reserved sweep: RFC1918 (all three), loopback, link-local,
  // CGNAT, 0.x, multicast, broadcast.
  for (const ip of [
    "10.0.0.5", "127.0.0.1", "169.254.10.9", "172.16.0.1", "172.31.255.254",
    "100.64.0.1", "100.127.255.1", "0.0.0.0", "224.0.0.1", "255.255.255.255",
  ]) {
    const result = await getIpLookup(ip);
    assert.equal(result?.bogon, true, `${ip} must be bogon`);
  }
  assert.equal(cacheReads.length, 0, "bogon IPs must never touch the cache");
  assert.equal(settingReads, 0, "bogon IPs must never read the token");
  assert.equal(fetchCalls.length, 0);
});

test("IPv6 loopback/unspecified/link-local/ULA short-circuit (case-insensitively); private-range neighbors do not", async () => {
  for (const ip of ["::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "FD00::1"]) {
    const result = await getIpLookup(ip);
    assert.equal(result?.bogon, true, `${ip} must be bogon`);
  }
  assert.equal(cacheReads.length, 0);

  // Boundary pin: the addresses just OUTSIDE the reserved ranges proceed to
  // the cache path (public as far as the local check is concerned).
  for (const ip of ["172.15.0.1", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111"]) {
    assert.equal(await getIpLookup(ip), null, `${ip} is public → cold miss with no token → null`);
  }
  assert.deepEqual(cacheReads, ["172.15.0.1", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111"]);
  assert.equal(fetchCalls.length, 0); // no token configured → never fetches
});

// ── cache TTL semantics ─────────────────────────────────────────────────────

test("a fresh found row is served as-is: exact field mapping, no token read, no fetch", async () => {
  seedRow("93.184.216.10", 29 * DAY_MS, {
    hostname: "example.net", city: "Norwell", region: "Massachusetts", country: "US",
    postal: "02061", latitude: 42.1596, longitude: -70.8217,
    timezone: "America/New_York", org: "AS15133 Edgecast Inc.",
  });
  // Input is trimmed before the cache lookup (copy-paste tolerance).
  assert.deepEqual(await getIpLookup("  93.184.216.10 "), {
    ip: "93.184.216.10",
    hostname: "example.net", city: "Norwell", region: "Massachusetts", country: "US",
    postal: "02061", latitude: 42.1596, longitude: -70.8217,
    timezone: "America/New_York", org: "AS15133 Edgecast Inc.",
    bogon: false,
  });
  assert.deepEqual(cacheReads, ["93.184.216.10"]);
  assert.equal(settingReads, 0, "a fresh cache hit must not even read the token");
  assert.equal(fetchCalls.length, 0);
});

test("a fresh notFound row is served with bogon:true and no refetch", async () => {
  ipinfoToken = "tok"; // token available — the fresh row must still win
  seedRow("203.0.113.9", 23 * 60 * 60 * 1000, { notFound: true });
  const result = await getIpLookup("203.0.113.9");
  assert.equal(result?.bogon, true);
  assert.equal(fetchCalls.length, 0);
});

test("TTLs are asymmetric: a notFound row expires after 24h while a found row of the same age is still fresh", async () => {
  ipinfoToken = "tok";
  respond = () => jsonResponse({ ip: "203.0.113.9", city: "Oslo" });

  // found row aged 25h → fresh (30-day TTL) → served, no fetch
  seedRow("198.51.100.7", 25 * 60 * 60 * 1000, { city: "Reykjavik" });
  assert.equal((await getIpLookup("198.51.100.7"))?.city, "Reykjavik");
  assert.equal(fetchCalls.length, 0);

  // notFound row aged 25h → stale (24-hour TTL) → refetched and healed
  seedRow("203.0.113.9", 25 * 60 * 60 * 1000, { notFound: true });
  const healed = await getIpLookup("203.0.113.9");
  assert.equal(fetchCalls.length, 1);
  assert.equal(healed?.city, "Oslo");
  assert.equal(healed?.bogon, false);
});

test("a found row past 30 days is refetched and the upsert overwrites it", async () => {
  ipinfoToken = "tok";
  seedRow("198.51.100.8", 31 * DAY_MS, { city: "Old Town" });
  respond = () => jsonResponse({ ip: "198.51.100.8", city: "New Town" });
  const result = await getIpLookup("198.51.100.8");
  assert.equal(fetchCalls.length, 1);
  assert.equal(result?.city, "New Town");
  assert.equal(upsertCalls.length, 1);
  assert.equal(upsertCalls[0].update.city, "New Town");
  assert.equal(upsertCalls[0].update.notFound, false);
  assert.ok(upsertCalls[0].update.fetchedAt instanceof Date, "refresh must re-stamp fetchedAt");
});

test("no token (or an empty-string token) → cache-only: stale row served, cold miss → null, zero fetches", async () => {
  seedRow("198.51.100.9", 40 * DAY_MS, { city: "Stale City" });
  assert.equal((await getIpLookup("198.51.100.9"))?.city, "Stale City");
  assert.equal(await getIpLookup("198.51.100.10"), null);

  ipinfoToken = ""; // cleared setting reads as unconfigured (`row?.value || null`)
  assert.equal(await getIpLookup("198.51.100.10"), null);
  assert.equal(fetchCalls.length, 0);
});

// ── the fetch path ──────────────────────────────────────────────────────────

test("cold miss with a token: exact wire URL (token URI-encoded), parsed upsert, mapped result", async () => {
  ipinfoToken = "s3cr3t token"; // admin-entered — must be encoded into the query
  respond = () =>
    jsonResponse({
      ip: "93.184.216.100",
      hostname: "host.example.com",
      city: "Berlin",
      region: "Berlin",
      country: "DE",
      postal: "10115",
      loc: "52.5200,13.4050",
      org: "AS3320 Deutsche Telekom AG",
      timezone: "Europe/Berlin",
    });
  const result = await getIpLookup("93.184.216.100");
  assert.deepEqual(fetchCalls, ["https://ipinfo.io/93.184.216.100/json?token=s3cr3t%20token"]);
  assert.deepEqual(result, {
    ip: "93.184.216.100",
    hostname: "host.example.com",
    city: "Berlin",
    region: "Berlin",
    country: "DE",
    postal: "10115",
    latitude: 52.52,
    longitude: 13.405,
    timezone: "Europe/Berlin",
    org: "AS3320 Deutsche Telekom AG",
    bogon: false,
  });
  assert.equal(upsertCalls.length, 1);
  assert.deepEqual(upsertCalls[0].create, {
    ip: "93.184.216.100",
    hostname: "host.example.com",
    city: "Berlin",
    region: "Berlin",
    country: "DE",
    postal: "10115",
    latitude: 52.52,
    longitude: 13.405,
    timezone: "Europe/Berlin",
    org: "AS3320 Deutsche Telekom AG",
    notFound: false,
  });
});

test("sparse/malformed upstream fields degrade to null per-field, never throw", async () => {
  ipinfoToken = "tok";
  // loc without a comma: lat parses, lon degrades to null.
  respond = () => jsonResponse({ ip: "203.0.113.20", loc: "12.5" });
  const half = await getIpLookup("203.0.113.20");
  assert.equal(half?.latitude, 12.5);
  assert.equal(half?.longitude, null);

  // loc entirely unparseable + every optional field absent → all nulls.
  respond = () => jsonResponse({ ip: "203.0.113.21", loc: "garbage" });
  assert.deepEqual(await getIpLookup("203.0.113.21"), {
    ip: "203.0.113.21", ...EMPTY_GEO, bogon: false,
  });
});

test("upstream bogon:true persists notFound:true with every geo field nulled", async () => {
  ipinfoToken = "tok";
  // A stale FOUND row exists — the bogon verdict must null its fields, not
  // let them shine through on the next cache hit.
  seedRow("203.0.113.30", 31 * DAY_MS, { city: "Ghost Town" });
  respond = () => jsonResponse({ ip: "203.0.113.30", bogon: true });
  const result = await getIpLookup("203.0.113.30");
  assert.deepEqual(result, { ip: "203.0.113.30", ...EMPTY_GEO, bogon: true });
  assert.equal(upsertCalls.length, 1);
  assert.equal(upsertCalls[0].update.notFound, true);
  assert.equal(upsertCalls[0].update.city, null);
});

test("HTTP non-2xx degrades to the stale row (or null) and logs with the [ip-lookup] scope", async () => {
  ipinfoToken = "tok";
  respond = () => jsonResponse({ error: "quota" }, 429);

  seedRow("203.0.113.40", 40 * DAY_MS, { city: "Stale But Served" });
  assert.equal((await getIpLookup("203.0.113.40"))?.city, "Stale But Served");
  assert.ok(errors.some((e) => e.includes("[ip-lookup]") && e.includes("HTTP 429")));
  assert.equal(upsertCalls.length, 0, "a failed refresh must not touch the cache row");

  assert.equal(await getIpLookup("203.0.113.41"), null); // no cached fallback → null
});

test("a network error and an unparseable body both degrade (stale row / null) and log, never throw", async () => {
  ipinfoToken = "tok";

  // fetch itself rejects → safe-fetch wraps it → the catch path logs + degrades.
  respond = () => { throw new TypeError("socket hang up"); };
  seedRow("203.0.113.50", 40 * DAY_MS, { org: "Cached Org" });
  assert.equal((await getIpLookup("203.0.113.50"))?.org, "Cached Org");
  assert.ok(errors.some((e) => e.includes("[ip-lookup] fetch failed for 203.0.113.50")));

  // HTTP 200 with a non-JSON body → res.json() throws inside the try → same degrade.
  respond = () => new Response("<html>challenge</html>", { status: 200 });
  assert.equal(await getIpLookup("203.0.113.51"), null);
  assert.equal(upsertCalls.length, 0);
});

test("testIpinfoConnection: no token throws; probe hits 8.8.8.8; org preferred over ip; HTTP/malformed map to errors", async () => {
  await assert.rejects(() => testIpinfoConnection(), /No ipinfo token configured/);
  assert.equal(fetchCalls.length, 0);

  ipinfoToken = "probe-token";
  respond = () => jsonResponse({ ip: "8.8.8.8", org: "AS15169 Google LLC" });
  assert.equal(await testIpinfoConnection(), "AS15169 Google LLC");
  assert.deepEqual(fetchCalls, ["https://ipinfo.io/8.8.8.8/json?token=probe-token"]);

  respond = () => jsonResponse({ ip: "8.8.8.8" }); // no org → falls back to the ip
  assert.equal(await testIpinfoConnection(), "8.8.8.8");

  respond = () => jsonResponse({ error: "denied" }, 403);
  await assert.rejects(() => testIpinfoConnection(), /ipinfo returned HTTP 403/);

  respond = () => jsonResponse({}); // 200 but no ip field
  await assert.rejects(() => testIpinfoConnection(), /malformed response/);
});
