// Unit tests for the DNS-resolution cache inside src/lib/ssrf.ts.
//
// The cache sits under every safe-fetch helper, so its failure modes are
// availability failures for the whole app: TMDB browse/search, the Radarr/Sonarr
// syncs, Plex/Jellyfin calls and web push all resolve through it.
//
// The property under test is that a FAILED lookup is never cached. An empty
// address list means "resolution failed", but every caller reads it as a hard
// block — resolveToSafeUrlWithAddrs returns null and safe-fetch raises
// SafeFetchError("ssrf-blocked"). Caching that turned one transient DNS blip into
// a full DNS_CACHE_TTL_MS (5 min) outage for the host, behind an error message
// blaming the SSRF policy.
//
// No network and no real DNS: dns.lookup is stubbed before the module graph
// loads (the tests/tmdb.test.mts idiom), and each test uses its own hostname so
// the module-global cache can't leak state between them.
import { test } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";

// ── DNS stub ────────────────────────────────────────────────────────────────
type LookupResult = { address: string; family: number }[];
let lookupCalls: string[] = [];
// Per-host queue of scripted answers; an entry that is an Error is thrown.
let script = new Map<string, Array<LookupResult | Error>>();

const fakeLookup = async (host: string): Promise<LookupResult> => {
  lookupCalls.push(host);
  const queue = script.get(host);
  const next = queue?.shift();
  if (next === undefined) throw new Error(`unscripted dns.lookup for ${host}`);
  if (next instanceof Error) throw next;
  return next;
};
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) {
  throw new Error("could not stub dns.lookup — aborting before a real DNS query can leave the process");
}

const { resolveToSafeUrl } = await import("../src/lib/ssrf.ts");

const PUBLIC: LookupResult = [{ address: "93.184.216.34", family: 4 }];

function scriptHost(host: string, answers: Array<LookupResult | Error>): void {
  script.set(host, answers);
}

function reset(): void {
  lookupCalls = [];
  script = new Map();
}

test("a FAILED lookup is not cached — the very next call re-queries DNS and succeeds", async () => {
  reset();
  const host = "recover-1.example.test";
  // First lookup fails (transient resolver blip), second succeeds.
  scriptHost(host, [new Error("EAI_AGAIN"), PUBLIC]);

  assert.equal(
    await resolveToSafeUrl(`https://${host}/a`),
    null,
    "a failed lookup must still block THIS request",
  );
  assert.equal(
    await resolveToSafeUrl(`https://${host}/a`),
    `https://${host}/a`,
    "once DNS recovers the next call must succeed — a cached empty result would " +
      "keep this blocked for the full 5-minute TTL",
  );
  assert.deepEqual(lookupCalls, [host, host], "the second call must actually re-query DNS");
});

test("an empty (NXDOMAIN-shaped) answer is likewise not cached", async () => {
  reset();
  const host = "recover-2.example.test";
  // dns.lookup resolving to an empty list — the same shape the internal
  // `.catch(() => [])` produces, reached without throwing.
  scriptHost(host, [[], PUBLIC]);

  assert.equal(await resolveToSafeUrl(`https://${host}/`), null);
  assert.equal(await resolveToSafeUrl(`https://${host}/`), `https://${host}`);
  assert.equal(lookupCalls.length, 2);
});

test("SUCCESSFUL lookups are still cached — the fix must not disable caching wholesale", async () => {
  reset();
  const host = "cached.example.test";
  // Exactly ONE scripted answer: a second real lookup would throw "unscripted".
  scriptHost(host, [PUBLIC]);

  assert.equal(await resolveToSafeUrl(`https://${host}/one`), `https://${host}/one`);
  assert.equal(await resolveToSafeUrl(`https://${host}/two`), `https://${host}/two`);
  assert.deepEqual(lookupCalls, [host], "the second resolve must be served from the cache");
});

test("a cached SAFE host is still re-checked against the policy, not blindly trusted", async () => {
  reset();
  // A host resolving to a private address is blocked under the user policy even
  // though the lookup itself succeeded — the cache stores addresses, not verdicts.
  const host = "private.example.test";
  scriptHost(host, [[{ address: "10.1.2.3", family: 4 }]]);
  assert.equal(await resolveToSafeUrl(`https://${host}/`), null);
  // Second call is served from cache and must reach the SAME verdict.
  assert.equal(await resolveToSafeUrl(`https://${host}/`), null);
  assert.deepEqual(lookupCalls, [host], "the private answer WAS cached (it resolved fine)");
});
