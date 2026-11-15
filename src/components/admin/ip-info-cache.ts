// The IpInfo popover's lookups (ip-info.tsx): one read of GET
// /api/admin/ip-lookup, and the module-level cache every IpInfo on the page
// shares. Kept out of the .tsx so the unit suite drives it
// (tests/ip-info-cache.test.mts). No clock read here: the caller passes `now`.
import { withBasePath } from "@/lib/base-path";
import { fetchJson } from "@/lib/client/fetch-json";
import { v, type Infer } from "@/lib/validate";

export const LookupSchema = v.object({
  ip: v.string(),
  hostname: v.nullable(v.string()),
  city: v.nullable(v.string()),
  region: v.nullable(v.string()),
  country: v.nullable(v.string()),
  postal: v.nullable(v.string()),
  latitude: v.nullable(v.number()),
  longitude: v.nullable(v.number()),
  timezone: v.nullable(v.string()),
  org: v.nullable(v.string()),
  bogon: v.boolean(),
});
export type Lookup = Infer<typeof LookupSchema>;

// The route's 404 ("nothing to look up with": no ipinfo token). Kept with the
// time it was learned, so an admin who adds a token sees lookups again within
// MISSING_TTL_MS instead of only after a full reload.
export type Missing = { missingAt: number };
export const MISSING_TTL_MS = 2 * 60_000;
export const isMissing = (entry: Lookup | Missing | undefined): entry is Missing => entry !== undefined && "missingAt" in entry;

/** A cached 404 still young enough to answer an open without asking again. */
export function isFreshMissing(entry: Lookup | Missing | undefined, now: number): entry is Missing {
  return isMissing(entry) && now - entry.missingAt < MISSING_TTL_MS;
}

// Module-level cache shared across all IpInfo instances. Bounded so it can't grow
// without limit as an admin scrolls activity surfaces with many distinct IPs —
// evict the oldest-inserted entry once at capacity (Map preserves insertion order).
export const CACHE_MAX = 200;
export const ipLookupCache = new Map<string, Lookup | Missing>();

export function cacheSet(ip: string, value: Lookup | Missing): void {
  if (ipLookupCache.size >= CACHE_MAX && !ipLookupCache.has(ip)) {
    const oldest = ipLookupCache.keys().next().value;
    if (oldest !== undefined) ipLookupCache.delete(oldest);
  }
  ipLookupCache.set(ip, value);
}

// What the popover says instead of a lookup. Kept as a kind (and the route's own
// already-translated text), never as translated text of ours, so a locale switch
// re-words it.
export type IpError = { kind: "missing" } | { kind: "failed"; message: string | null };

// One lookup, read the way the route answers it:
//   200 → the lookup; 404 → nothing to look up with (cached, for a while);
//   anything else (429, 503, no answer, a body that isn't a lookup) → transient,
//   never cached, so the next open asks again.
export type LookupOutcome = { kind: "found"; lookup: Lookup } | { kind: "missing" } | { kind: "failed"; message: string | null };

// Rows showing the same IP share one request while it is in flight.
const inFlightLookups = new Map<string, Promise<LookupOutcome>>();

export function lookupIp(ip: string): Promise<LookupOutcome> {
  const pending = inFlightLookups.get(ip);
  if (pending) return pending;
  const run = readLookup(ip).finally(() => inFlightLookups.delete(ip));
  inFlightLookups.set(ip, run);
  return run;
}

async function readLookup(ip: string): Promise<LookupOutcome> {
  const res = await fetchJson(withBasePath(`/api/admin/ip-lookup?ip=${encodeURIComponent(ip)}`), { schema: LookupSchema });
  if (res.ok) return { kind: "found", lookup: res.data };
  if (res.kind === "http" && res.status === 404) return { kind: "missing" };
  return { kind: "failed", message: res.kind === "http" && res.error ? res.error : null };
}

// What a fresh mount (or a new `ip`) shows before any open: the cache's word.
// No clock here (render): a stale "missing" is only re-asked on open.
export function cachedView(ip: string): { data: Lookup | null; error: IpError | null } {
  const c = ipLookupCache.get(ip);
  if (isMissing(c)) return { data: null, error: { kind: "missing" } };
  return { data: c ?? null, error: null };
}

