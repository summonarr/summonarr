// Unit tests for getCachedPlexAllowlist (src/lib/plex-membership.ts) — the
// per-replica, per-instance cache of the Plex servers' shared-user allowlist
// that verifyAndRefreshSession consults on the slow path to lock out users who
// were un-shared from every server. The contracts pinned here are the ones a
// wrong refactor would turn into a mass logout or a dead lockout:
//   - null means "no opinion" and callers fail OPEN: unconfigured settings, a
//     failed plex.tv fetch, an unresolvable machineId, and an EMPTY friend set
//     (which would otherwise lock out every Plex user) all yield null — and
//     the admin email must never be appended before the empty-set guard, or an
//     admin-only response would masquerade as a valid one-member allowlist;
//   - a prior good set is served STALE during an outage or on an empty
//     re-fetch (keeps enforcing last-known membership) instead of reverting to
//     "no opinion";
//   - one plex.tv fetch per instance per replica per 30-min TTL window: fresh
//     cache ⇒ zero upstream traffic; expired cache ⇒ stale served instantly
//     while ONE background refresh runs; concurrent cold callers share one
//     in-flight fetch; failed attempts arm a 5-min retry backoff — all PER
//     SLUG (the multi-instance block at the bottom);
//   - multi-instance: the returned Set is the UNION of every configured
//     instance's scoped set, an UNCONFIGURED registry entry contributes
//     nothing without poisoning, and a configured-but-COLD instance whose
//     fetch fails or comes back empty poisons the WHOLE call to null (a
//     partial union would mass-revoke the down server's users);
//   - membership emails arrive lowercased (plex.ts) and each instance's
//     configured admin email is appended lowercased+trimmed to ITS OWN set.
//
// The cache/backoff state is module-global and deliberately has no reset API,
// so THESE TESTS ARE ORDER-DEPENDENT: they advance a stubbed Date.now through
// one scripted timeline (cold failures → first good set → TTL → stale-serve →
// the multi-instance block, which introduces fresh slugs where it needs fresh
// state). No DB, network, or DNS: prisma is pre-seeded on globalThis with a
// fake (poster-cache.test pattern) before the module graph loads,
// globalThis.fetch is scripted per URL (the per-server /identity and
// plex.tv/api/users hops that getPlexFriendEmails really makes — plex.tv
// responses discriminate on the X-Plex-Token header), and dns/promises.lookup
// is stubbed for the plex.tv SSRF resolve.
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

// Additional named-instance servers for the multi-instance block. Each server
// gets its own /identity endpoint keyed by URL; the single plex.tv/api/users
// endpoint discriminates responses on the per-instance admin token.
const REMOTE_URL = "http://203.0.113.20:32400";
const REMOTE_MACHINE = "machine-remote";
const REMOTE_TOKEN = "remote-plex-token";
const ARCTIC_URL = "http://203.0.113.30:32400";
const ARCTIC_TOKEN = "arctic-plex-token";
const BRINE_URL = "http://203.0.113.40:32400";
const BRINE_MACHINE = "machine-brine";
const BRINE_TOKEN = "brine-plex-token";
const TARDY_URL = "http://203.0.113.50:32400";
const TARDY_MACHINE = "machine-tardy";
const TARDY_TOKEN = "tardy-plex-token";

type FetchCall = { url: string; headers: Headers };
type Responder = () => Response | Promise<Response>;
const identityCalls: FetchCall[] = [];
const usersCalls: FetchCall[] = [];
const identityJson = (machine: string) =>
  new Response(JSON.stringify({ MediaContainer: { machineIdentifier: machine } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
let identityResponder: Responder = () => identityJson(MACHINE_ID);
const remoteIdentityResponder: Responder = () => identityJson(REMOTE_MACHINE);
let arcticIdentityResponder: Responder = () => {
  throw new Error("unexpected arctic /identity fetch — script a responder for this test");
};
const brineIdentityResponder: Responder = () => identityJson(BRINE_MACHINE);
const tardyIdentityResponder: Responder = () => identityJson(TARDY_MACHINE);
// usersResponder receives the recorded call so multi-instance tests can key
// the response off headers.get("x-plex-token"); single-server tests ignore it.
let usersResponder: (call: FetchCall) => Response | Promise<Response> = () => {
  throw new Error("unexpected /api/users fetch — script a responder for this test");
};

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const call = { url, headers: new Headers(init?.headers) };
  if (url.startsWith(`${SERVER_URL}/identity`)) {
    identityCalls.push(call);
    return identityResponder();
  }
  if (url.startsWith(`${REMOTE_URL}/identity`)) {
    identityCalls.push(call);
    return remoteIdentityResponder();
  }
  if (url.startsWith(`${ARCTIC_URL}/identity`)) {
    identityCalls.push(call);
    return arcticIdentityResponder();
  }
  if (url.startsWith(`${BRINE_URL}/identity`)) {
    identityCalls.push(call);
    return brineIdentityResponder();
  }
  if (url.startsWith(`${TARDY_URL}/identity`)) {
    identityCalls.push(call);
    return tardyIdentityResponder();
  }
  if (url.startsWith("https://plex.tv/api/users")) {
    usersCalls.push(call);
    return usersResponder(call);
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

test("unconfigured → null (fail open) after reading exactly the registry + the default instance's three settings, no upstream call", async () => {
  settings = {};
  assert.equal(await getCachedPlexAllowlist(), null);
  // The instance registry (plexInstances) is one findUnique per call; the
  // default instance's attempt reads its connection pair + admin email.
  assert.deepEqual(settingReadKeys.sort(), [
    "plexAdminEmail",
    "plexAdminToken",
    "plexInstances",
    "plexServerUrl",
  ]);
  assert.equal(identityCalls.length, 0);
  assert.equal(usersCalls.length, 0);
});

test("an UNCONFIGURED attempt does NOT arm the backoff: the next call re-reads the instance settings (still null, still zero upstream)", async () => {
  // The backoff exists to protect plex.tv; an unconfigured attempt never
  // reached plex.tv, and caching its verdict would keep serving "skip this
  // instance" after an admin finishes configuring it — in a multi-instance
  // union that stale skip is an ENFORCING partial result (the mass-revoke
  // shape pinned by the transition test at the end of this file). So the
  // repeat call must re-derive: registry + the instance's three settings
  // again, and still no server contact. (A genuinely FAILED fetch DOES arm
  // the backoff — pinned in the POISON test's backoff-interaction block.)
  fakeNow += 1 * MIN;
  settingReadKeys.length = 0;
  assert.equal(await getCachedPlexAllowlist(), null);
  assert.deepEqual(settingReadKeys.sort(), [
    "plexAdminEmail",
    "plexAdminToken",
    "plexInstances",
    "plexServerUrl",
  ]);
  assert.equal(identityCalls.length, 0);
  assert.equal(usersCalls.length, 0);
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

// ── multi-instance (the timeline continues; new slugs start cold) ───────────

const registryJson = (...slugs: string[]) => JSON.stringify(slugs.map((slug) => ({ slug, name: slug })));

test("an outage instance serves STALE into the union while a healthy instance contributes fresh — the outage never blanks the other server", async () => {
  fakeNow += 6 * MIN; // past the default instance's backoff from the empty re-fetch above
  settings = {
    plexAdminToken: ADMIN_TOKEN,
    plexAdminEmail: " Admin@Example.COM ",
    plexServerUrl: SERVER_URL,
    plexInstances: registryJson("remote"),
    plexRemoteServerUrl: REMOTE_URL,
    plexRemoteAdminToken: REMOTE_TOKEN,
    plexRemoteAdminEmail: "RAdmin@Example.com",
  };
  usersResponder = (call) => {
    const token = call.headers.get("x-plex-token");
    // Default instance: plex.tv outage — its background refresh fails, so its
    // STALE set must keep being served into the union.
    if (token === ADMIN_TOKEN) return new Response("outage", { status: 503 });
    // Remote instance: healthy. sneak@ rides the response on the DEFAULT
    // server's machine id — remote's scoping must exclude it.
    if (token === REMOTE_TOKEN)
      return xmlResponse(
        usersXml([
          { email: "rfriend@example.com", machine: REMOTE_MACHINE },
          { email: "sneak@example.com", machine: MACHINE_ID },
        ]),
      );
    throw new Error(`unexpected plex.tv token ${token}`);
  };

  // Cold remote is awaited; stale default is served without waiting for its
  // (failing) refresh. The union carries BOTH — this is the pin that one
  // server's outage doesn't blank the other's membership.
  const union = await getCachedPlexAllowlist();
  assert.ok(union, "an outage on one instance must not fail the whole union open");
  assert.deepEqual(
    [...union].sort(),
    ["admin@example.com", "newuser@example.com", "radmin@example.com", "rfriend@example.com"],
    "stale default ∪ fresh remote, each instance's admin in its own contribution, sneak scoped out",
  );
  await flushAsync(); // default's failed refresh settles; its cache is retained
  assert.ok(
    warns.some((w) => w.includes("[plex-membership]") && w.includes("Failed to fetch Plex users")),
    "the failed per-instance refresh must warn with the [plex-membership] scope",
  );
});

test("union across two healthy instances, each scoped to its OWN machineIdentifier", async () => {
  fakeNow += 6 * MIN; // past the default instance's backoff armed by the failed refresh above
  const identityBefore = identityCalls.length;
  const usersBefore = usersCalls.length;
  usersResponder = (call) => {
    const token = call.headers.get("x-plex-token");
    // evil@ rides the DEFAULT server's response on the REMOTE machine id —
    // the default's scoping must exclude it.
    if (token === ADMIN_TOKEN)
      return xmlResponse(
        usersXml([
          { email: "dfriend@example.com", machine: MACHINE_ID },
          { email: "evil@example.com", machine: REMOTE_MACHINE },
        ]),
      );
    // Remote is inside its 30-min TTL — it must not refetch at all (also
    // pinned by the call-count deltas below; this throw alone would be
    // swallowed into a stale-serve).
    throw new Error(`unexpected plex.tv refetch for token ${token}`);
  };

  // The default is stale → served stale while ONE background refresh lands.
  const first = await getCachedPlexAllowlist();
  assert.ok(first);
  await flushAsync();

  const union = await getCachedPlexAllowlist();
  assert.ok(union);
  assert.deepEqual(
    [...union].sort(),
    ["admin@example.com", "dfriend@example.com", "radmin@example.com", "rfriend@example.com"],
    "fresh ∪ fresh: evil@ (wrong machine in default's response) and sneak@ (wrong machine in remote's) both scoped out",
  );
  assert.equal(identityCalls.length - identityBefore, 1, "only the default instance refetches");
  assert.equal(usersCalls.length - usersBefore, 1, "the remote instance must serve its TTL-fresh cache");
});

test("POISON: a configured-but-COLD instance whose fetch can't produce a set nulls the WHOLE call — the healthy sets must NOT be returned", async () => {
  fakeNow += 1 * MIN; // default + remote both TTL-fresh
  settings.plexInstances = registryJson("remote", "arctic");
  settings.plexArcticServerUrl = ARCTIC_URL;
  settings.plexArcticAdminToken = ARCTIC_TOKEN;
  // The admin email is deliberately configured: if it were appended BEFORE the
  // empty-set guard, arctic would masquerade as a healthy one-member instance
  // and defeat the poison — this test would fail with a non-null union.
  settings.plexArcticAdminEmail = "IceAdmin@Example.com";
  arcticIdentityResponder = () => new Response("nope", { status: 500 }); // machineId unresolvable → empty set

  const result = await getCachedPlexAllowlist();
  assert.equal(
    result,
    null,
    "a cold indeterminate instance must poison the whole union — returning the healthy servers' sets would let session-refresh mass-revoke every user whose only membership is on the down server",
  );

  // Backoff interaction: still cold, still indeterminate INSIDE the 5-min
  // retry window (no new attempt is even made) — the call stays null.
  fakeNow += 1 * MIN;
  const identityBefore = identityCalls.length;
  const usersBefore = usersCalls.length;
  const inBackoff = await getCachedPlexAllowlist();
  assert.equal(inBackoff, null, "a cold instance inside its backoff window is still indeterminate");
  assert.equal(identityCalls.length, identityBefore, "no re-attempt inside the backoff window");
  assert.equal(usersCalls.length, usersBefore);
});

test("an UNCONFIGURED registry entry contributes nothing and does NOT poison", async () => {
  fakeNow += 1 * MIN;
  // The admin removed arctic from the registry (its lingering slug state is
  // inert once deregistered) and registered "ghost" without ever entering a
  // server url/token for it.
  settings.plexInstances = registryJson("remote", "ghost");
  settingReadKeys.length = 0;
  const identityBefore = identityCalls.length;
  const usersBefore = usersCalls.length;

  const union = await getCachedPlexAllowlist();
  assert.ok(union, "an unconfigured instance must be skipped, not treated as indeterminate");
  assert.deepEqual(
    [...union].sort(),
    ["admin@example.com", "dfriend@example.com", "radmin@example.com", "rfriend@example.com"],
  );
  assert.equal(identityCalls.length, identityBefore, "an unconfigured instance never contacts a server");
  assert.equal(usersCalls.length, usersBefore);
  // ghost's attempt read exactly its own keys (proving it was considered and
  // then skipped); the TTL-fresh default/remote instances read nothing.
  assert.deepEqual(settingReadKeys.sort(), [
    "plexGhostAdminEmail",
    "plexGhostAdminToken",
    "plexGhostServerUrl",
    "plexInstances",
  ]);
});

test("a cold instance whose SCOPED set is empty is indeterminate — its admin email must not masquerade as a one-member allowlist (guard before append, per slug)", async () => {
  fakeNow += 1 * MIN;
  settings.plexInstances = registryJson("remote", "brine");
  settings.plexBrineServerUrl = BRINE_URL;
  settings.plexBrineAdminToken = BRINE_TOKEN;
  settings.plexBrineAdminEmail = "BrineAdmin@Example.com";
  usersResponder = (call) => {
    const token = call.headers.get("x-plex-token");
    // plex.tv answers brine's query fine, but the only shared user is on the
    // DEFAULT server's machine — brine's scoped set is EMPTY.
    if (token === BRINE_TOKEN)
      return xmlResponse(usersXml([{ email: "elsewhere@example.com", machine: MACHINE_ID }]));
    throw new Error(`unexpected plex.tv refetch for token ${token}`);
  };

  const result = await getCachedPlexAllowlist();
  // If brine's admin email were appended before ITS OWN empty-set guard, brine
  // would look healthy ({brineadmin@example.com}) and this would be a union
  // instead of null.
  assert.equal(result, null, "a cold empty-set instance must poison the call, not contribute its admin email");

  // Poison is registry-driven, not sticky: drop brine and the union returns.
  settings.plexInstances = registryJson("remote");
  const recovered = await getCachedPlexAllowlist();
  assert.ok(recovered, "removing the sick instance from the registry restores the union");
  assert.deepEqual(
    [...recovered].sort(),
    ["admin@example.com", "dfriend@example.com", "radmin@example.com", "rfriend@example.com"],
  );
});

test("unconfigured→configured transition: an 'unconfigured' verdict never arms the backoff — the next call re-reads config and the new instance joins the union immediately", async () => {
  // The mass-revoke regression this pins: an admin registers an instance
  // before its token is saved (the media-instances route writes the registry
  // and the connection Settings in separate awaits, so this state is real). If
  // the "unconfigured" attempt armed the 5-min backoff, the recheck would keep
  // serving that stale verdict after the token lands — an ENFORCING partial
  // union missing the new server's members, revoking them for the rest of the
  // window. Legacy single-server behavior for this transition was fail-open
  // (null); per-slug state must not turn it fail-closed-partial.
  fakeNow += 1 * MIN;
  settings.plexInstances = registryJson("remote", "tardy");
  settings.plexTardyServerUrl = TARDY_URL;
  // No plexTardyAdminToken yet — registered but unconfigured.
  const usersBefore = usersCalls.length;

  const during = await getCachedPlexAllowlist();
  assert.ok(during, "an unconfigured instance is skipped, not poisoned");
  assert.ok(!warns.some((w) => w.includes("tardy")), "an unconfigured skip is silent");
  assert.equal(usersCalls.length, usersBefore, "no upstream traffic for an unconfigured instance");

  // The admin saves the token 60s later — deep inside what a failed fetch's
  // 5-min backoff window would be.
  fakeNow += 1 * MIN;
  settings.plexTardyAdminToken = TARDY_TOKEN;
  settings.plexTardyAdminEmail = "TardyAdmin@Example.com";
  usersResponder = (call) => {
    const token = call.headers.get("x-plex-token");
    if (token === TARDY_TOKEN)
      return xmlResponse(usersXml([{ email: "tfriend@example.com", machine: TARDY_MACHINE }]));
    throw new Error(`unexpected plex.tv refetch for token ${token}`);
  };

  const after = await getCachedPlexAllowlist();
  assert.ok(after, "the newly-configured instance must be fetched, not skipped on a stale verdict");
  assert.ok(
    after.has("tfriend@example.com") && after.has("tardyadmin@example.com"),
    "the new instance's members must join the union on the FIRST call after configuration — a stale 'unconfigured' skip here is the enforcing-partial-union mass-revoke bug",
  );
  assert.equal(usersCalls.length - usersBefore, 1, "the transition call performed a real fetch for the new instance");
});
