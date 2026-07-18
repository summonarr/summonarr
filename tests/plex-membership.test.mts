// Unit tests for getCachedPlexAllowlist (src/lib/plex-membership.ts) — the
// per-replica cache of the Plex server's shared-user allowlist that
// verifyAndRefreshSession consults on the slow path to lock out users who were
// un-shared from the server. The contracts pinned here are the ones a wrong
// refactor would turn into a mass logout or a dead lockout:
//   - null means "no opinion" and callers fail OPEN: unconfigured settings, a
//     failed plex.tv fetch, an unresolvable machineId, and an EMPTY friend set
//     (which would otherwise lock out every Plex user) all yield null — and
//     the admin email must never be appended before the empty-set guard, or an
//     admin-only response would masquerade as a valid one-member allowlist;
//   - a prior good set is served STALE during an outage or on an empty
//     re-fetch (keeps enforcing last-known membership) instead of reverting to
//     "no opinion";
//   - one plex.tv fetch per replica per 30-min TTL window: fresh cache ⇒ zero
//     upstream traffic; expired cache ⇒ stale served instantly while ONE
//     background refresh runs; concurrent cold callers share one in-flight
//     fetch; failed attempts arm a 5-min retry backoff;
//   - membership emails arrive lowercased (plex.ts) and the configured admin
//     email is appended lowercased+trimmed.
//
// The cache/backoff state is module-global and deliberately has no reset API,
// so THESE TESTS ARE ORDER-DEPENDENT: they advance a stubbed Date.now through
// one scripted timeline (cold failures → first good set → TTL → stale-serve).
// No DB, network, or DNS: prisma is pre-seeded on globalThis with a fake
// (poster-cache.test pattern) before the module graph loads, globalThis.fetch
// is scripted per URL (the /identity and plex.tv/api/users hops that
// getPlexFriendEmails really makes), and dns/promises.lookup is stubbed for
// the plex.tv SSRF resolve.
import { test } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // prisma.ts pulls in token-crypto

// ── DNS stub (see tests/trakt.test.mts for the rationale) ───────────────────
const fakeLookup = async () => [{ address: "93.184.216.34", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) {
  throw new Error("could not stub dns.lookup — aborting before a real DNS query can leave the process");
}

// ── console capture ─────────────────────────────────────────────────────────
const warns: string[] = [];
const errors: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

// ── stubbed clock ───────────────────────────────────────────────────────────
// The module reads Date.now() at call time for the TTL and backoff windows.
const MIN = 60_000;
let fakeNow = 1_750_000_000_000;
Date.now = () => fakeNow;

// ── fake prisma, pre-seeded before the module graph loads ───────────────────
let settings: Record<string, string | undefined> = {};
const settingReadKeys: string[] = [];
const fakePrisma = {
  setting: {
    findUnique: async (args: { where: { key: string } }) => {
      settingReadKeys.push(args.where.key);
      const value = settings[args.where.key];
      return value === undefined ? null : { key: args.where.key, value };
    },
  },
};
(globalThis as unknown as { prisma: unknown }).prisma = fakePrisma;

// ── scripted fetch: the two real upstream hops ──────────────────────────────
const SERVER_URL = "http://203.0.113.10:32400"; // IP-literal: no DNS hop for the identity call
const MACHINE_ID = "machine-abc";
const ADMIN_TOKEN = "admin-plex-token";

type FetchCall = { url: string; headers: Headers };
const identityCalls: FetchCall[] = [];
const usersCalls: FetchCall[] = [];
let identityResponder: () => Response | Promise<Response> = () =>
  new Response(JSON.stringify({ MediaContainer: { machineIdentifier: MACHINE_ID } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
let usersResponder: () => Response | Promise<Response> = () => {
  throw new Error("unexpected /api/users fetch — script a responder for this test");
};

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const call = { url, headers: new Headers(init?.headers) };
  if (url.startsWith(`${SERVER_URL}/identity`)) {
    identityCalls.push(call);
    return identityResponder();
  }
  if (url.startsWith("https://plex.tv/api/users")) {
    usersCalls.push(call);
    return usersResponder();
  }
  throw new Error(`unexpected fetch to ${url}`);
}) as typeof fetch;

const identityOk = () =>
  new Response(JSON.stringify({ MediaContainer: { machineIdentifier: MACHINE_ID } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

// plex.tv/api/users XML: a <User …> block per account, carrying the servers
// each one is shared on. getPlexFriendEmails scopes to OUR machineIdentifier.
function usersXml(users: Array<{ email: string; machine: string }>): string {
  const blocks = users
    .map(
      (u, i) =>
        `<User id="${i + 1}" title="user${i + 1}" email="${u.email}">` +
        `<Server id="${i + 1}" machineIdentifier="${u.machine}"/></User>`,
    )
    .join("");
  return `<?xml version="1.0"?><MediaContainer size="${users.length}">${blocks}</MediaContainer>`;
}
const xmlResponse = (xml: string) =>
  new Response(xml, { status: 200, headers: { "content-type": "application/xml" } });

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// Drain the background-refresh promise chain (setting reads → identity fetch →
// users fetch → XML parse → cache swap). Pure microtask/immediate work, so a
// bounded setImmediate loop is deterministic.
async function flushAsync(rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
}

const configured = () => {
  settings = {
    plexAdminToken: ADMIN_TOKEN,
    plexAdminEmail: " Admin@Example.COM ", // exercises the lowercase+trim on append
    plexServerUrl: SERVER_URL,
  };
};

// Dynamic import so every stub above precedes the module-graph load.
const { getCachedPlexAllowlist } = await import("../src/lib/plex-membership.ts");

// ── the scripted timeline ───────────────────────────────────────────────────

test("unconfigured → null (fail open) after reading exactly the three plex settings, no upstream call", async () => {
  settings = {};
  assert.equal(await getCachedPlexAllowlist(), null);
  assert.deepEqual(settingReadKeys.sort(), ["plexAdminEmail", "plexAdminToken", "plexServerUrl"]);
  assert.equal(identityCalls.length, 0);
  assert.equal(usersCalls.length, 0);
});

test("a failed attempt arms the 5-min backoff: a call inside the window doesn't even re-read settings", async () => {
  fakeNow += 1 * MIN;
  settingReadKeys.length = 0;
  assert.equal(await getCachedPlexAllowlist(), null);
  assert.equal(settingReadKeys.length, 0); // no new fetchAllowlist attempt at all
});

test("whitespace-only token still reads as unconfigured (trim guard) → null, server never contacted", async () => {
  fakeNow += 6 * MIN; // past the backoff
  settings = { plexAdminToken: "   \t", plexServerUrl: SERVER_URL };
  assert.equal(await getCachedPlexAllowlist(), null);
  assert.equal(identityCalls.length, 0);
});

test("unresolvable machineId → refusal (empty set) → null, with the [plex] warn", async () => {
  fakeNow += 6 * MIN;
  configured();
  identityResponder = () => new Response("nope", { status: 500 });
  assert.equal(await getCachedPlexAllowlist(), null);
  assert.equal(identityCalls.length, 1);
  assert.equal(usersCalls.length, 0); // refused before the friend enumeration
  assert.ok(
    warns.some((w) => w.includes("[plex]") && w.includes("machineId")),
    "the machineId refusal must warn with the [plex] scope",
  );
});

test("plex.tv /api/users failure (non-2xx throw) is swallowed → null, not a crash", async () => {
  fakeNow += 6 * MIN;
  identityResponder = identityOk;
  usersResponder = () => new Response("plex.tv exploded", { status: 502 });
  assert.equal(await getCachedPlexAllowlist(), null);
  assert.equal(usersCalls.length, 1);
});

test("an EMPTY scoped friend set is 'no opinion' → null; the admin email must not mask it", async () => {
  fakeNow += 6 * MIN;
  // One shared user exists, but on a DIFFERENT server — scoped set is empty.
  usersResponder = () => xmlResponse(usersXml([{ email: "other@example.com", machine: "machine-elsewhere" }]));
  assert.equal(await getCachedPlexAllowlist(), null);
  // If the admin email were appended before the empty-set guard, this would
  // have returned a one-member set and locked out every real friend.
});

test("cold-cache success: concurrent callers share ONE in-flight fetch; emails lowercased; admin appended", async () => {
  fakeNow += 6 * MIN;
  const identityBefore = identityCalls.length;
  const usersBefore = usersCalls.length;
  const gate = deferred<Response>();
  usersResponder = () => gate.promise;

  const p1 = getCachedPlexAllowlist();
  const p2 = getCachedPlexAllowlist(); // second caller while the first is in flight
  try {
    await flushAsync(); // let both reach (and block on) the users fetch
    assert.equal(identityCalls.length - identityBefore, 1, "concurrent cold callers must share one refresh");
    assert.equal(usersCalls.length - usersBefore, 1, "concurrent cold callers must share one friend fetch");

    // Wire shape: both hops carry the admin token.
    assert.equal(identityCalls[identityCalls.length - 1].headers.get("x-plex-token"), ADMIN_TOKEN);
    assert.equal(usersCalls[usersCalls.length - 1].headers.get("x-plex-token"), ADMIN_TOKEN);
  } finally {
    // Resolve even on assertion failure — an unresolved gate would leave the
    // module's inflight promise pending and deadlock every later cold call.
    gate.resolve(
      xmlResponse(
        usersXml([
          { email: "Friend@Example.COM", machine: MACHINE_ID }, // ours — lowercased on ingest
          { email: "stranger@example.com", machine: "machine-elsewhere" }, // different server — excluded
        ]),
      ),
    );
  }
  const [s1, s2] = await Promise.all([p1, p2]);
  assert.ok(s1 && s2);
  assert.equal(s1, s2, "both callers must receive the same cached Set instance");
  assert.deepEqual([...s1].sort(), ["admin@example.com", "friend@example.com"]);
});

test("within the 30-min TTL the cached set is served with zero upstream traffic", async () => {
  fakeNow += 10 * MIN;
  const identityBefore = identityCalls.length;
  const usersBefore = usersCalls.length;
  usersResponder = () => {
    throw new Error("must not refetch inside the TTL window");
  };
  const set = await getCachedPlexAllowlist();
  assert.ok(set);
  assert.deepEqual([...set].sort(), ["admin@example.com", "friend@example.com"]);
  assert.equal(identityCalls.length, identityBefore);
  assert.equal(usersCalls.length, usersBefore);
});

test("past the TTL: stale set served instantly, ONE background refresh swaps membership for the next call", async () => {
  fakeNow += 25 * MIN; // 35 min since the set was fetched — expired
  const gate = deferred<Response>();
  usersResponder = () => gate.promise;

  try {
    // Served stale, synchronously with respect to the pending refresh.
    const stale = await getCachedPlexAllowlist();
    assert.ok(stale);
    assert.deepEqual([...stale].sort(), ["admin@example.com", "friend@example.com"]);
  } finally {
    // Resolve even on assertion failure so the module's inflight slot clears.
    gate.resolve(xmlResponse(usersXml([{ email: "newuser@example.com", machine: MACHINE_ID }])));
  }
  await flushAsync();

  const usersBefore = usersCalls.length;
  const fresh = await getCachedPlexAllowlist(); // fetchedAt was renewed — no new fetch
  assert.ok(fresh);
  assert.deepEqual([...fresh].sort(), ["admin@example.com", "newuser@example.com"]);
  assert.equal(usersCalls.length, usersBefore);
});

test("outage after a good set: stale membership keeps being enforced, never null", async () => {
  fakeNow += 31 * MIN;
  usersResponder = () => new Response("outage", { status: 503 });
  const duringOutage = await getCachedPlexAllowlist();
  assert.ok(duringOutage, "an outage must serve the last-known set, not fail open to null");
  assert.deepEqual([...duringOutage].sort(), ["admin@example.com", "newuser@example.com"]);
  await flushAsync(); // failed refresh settles; cache must be retained
  const afterFailure = await getCachedPlexAllowlist(); // inside the retry backoff — no new attempt
  const usersBefore = usersCalls.length;
  assert.ok(afterFailure);
  assert.deepEqual([...afterFailure].sort(), ["admin@example.com", "newuser@example.com"]);
  assert.equal(usersCalls.length, usersBefore);
});

test("an empty re-fetch after a good set also serves stale — a truncated friend list must not log everyone out", async () => {
  fakeNow += 6 * MIN; // past the backoff armed by the failed refresh above
  usersResponder = () => xmlResponse(usersXml([])); // plex.tv answers, but with nobody on our server
  const set = await getCachedPlexAllowlist();
  assert.ok(set);
  assert.deepEqual([...set].sort(), ["admin@example.com", "newuser@example.com"]);
  await flushAsync();
  const after = await getCachedPlexAllowlist();
  assert.ok(after, "the empty result must not replace the cached set");
  assert.deepEqual([...after].sort(), ["admin@example.com", "newuser@example.com"]);
});
