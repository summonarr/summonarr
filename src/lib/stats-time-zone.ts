// The time zone the play-history statistics count hours and days in: the
// activity heatmaps and calendar, the daily series, the drill-downs, My Stats
// and Wrapped. Pure and zero-import, so client components can label with it;
// the stored setting is read by stats-time-zone-data.ts.
//
// PlayHistory.startedAt is a timestamp WITHOUT time zone that holds UTC, so a
// bucket is taken on (("startedAt" AT TIME ZONE 'UTC') AT TIME ZONE $zone): the
// first AT TIME ZONE reads the stored value as UTC, the second gives the wall
// clock in the zone. The zone is always a BOUND parameter, never SQL text.

export const STATS_TIME_ZONE_KEY = "statsTimeZone";
export const UTC_ZONE = "UTC";

// What a zone name may look like once Intl has canonicalized it. It refuses the
// bare offsets Intl also accepts ("+05:00"): Postgres reads a bare offset
// POSIX-style, east and west swapped, so its buckets would land the offset twice
// over in the wrong direction.
const IANA_NAME = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;
const MAX_ZONE_LENGTH = 64;

// The canonical IANA name for `value` ("america/new_york" → "America/New_York",
// "Etc/UTC" → "UTC"), or null when it is not a zone Intl knows by name.
export function normalizeTimeZone(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_ZONE_LENGTH) return null;
  let canonical: string | undefined;
  try {
    canonical = new Intl.DateTimeFormat("en", { timeZone: trimmed }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
  return typeof canonical === "string" && IANA_NAME.test(canonical) ? canonical : null;
}

// The server process's own zone (the TZ env, which the quota windows follow
// too), or UTC when it is unset or unusable. Read on every call: Node applies a
// TZ change at runtime.
export function processTimeZone(): string {
  let zone: string | undefined;
  try {
    zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    zone = undefined;
  }
  return normalizeTimeZone(zone) ?? UTC_ZONE;
}

// THE rule: the stored setting when it names a valid zone, else the process
// zone, else UTC. A bad stored value (written by hand, or a zone a later Intl
// no longer knows) falls back instead of failing every statistics query.
// The fallback is only worked out when the stored value is unusable, so the
// common case (a valid stored zone, or the cached read) builds one Intl
// formatter, not three.
export function resolveStatsTimeZone(
  stored: string | null | undefined,
  fallback?: string,
): string {
  return normalizeTimeZone(stored) ?? normalizeTimeZone(fallback ?? processTimeZone()) ?? UTC_ZONE;
}

// "UTC", or the zone's last segment with spaces ("America/New_York" →
// "New York"): the compact marker beside a chart. Its title carries the full name.
export function zoneShortLabel(zone: string): string {
  if (zone === UTC_ZONE) return UTC_ZONE;
  const last = zone.slice(zone.lastIndexOf("/") + 1);
  return last.replace(/_/g, " ") || zone;
}

// YYYY-MM-DD of `instant` on the zone's wall clock — the same key the SQL day
// buckets produce.
export function zonedDayKey(instant: Date, zone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

// Every day key from `from` to `to`, inclusive, oldest first. Calendar
// arithmetic on the dates themselves, so a DST change never skips or repeats one.
export function dayKeysBetween(from: string, to: string): string[] {
  const parse = (day: string) => {
    const [y, m, d] = day.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  const start = parse(from);
  const end = parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return [];
  const out: string[] = [];
  for (let t = start; t <= end; t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

// The calendar components walk day keys with UTC date arithmetic from an ISO
// "today". Handing them the zone's date at UTC midnight makes that walk produce
// the zone's day keys.
export function zonedTodayIso(now: Date, zone: string): string {
  return `${zonedDayKey(now, zone)}T00:00:00.000Z`;
}

// The zone is always BOUND (guardrail 19g): `zoneRef` must be a placeholder,
// "$n" or "?", never a zone name or any other SQL. A caller that passes one is
// a bug, refused here before it can reach $queryRawUnsafe.
const PLACEHOLDER = /^(?:\$[1-9][0-9]*|\?)$/;

function assertPlaceholder(zoneRef: string): void {
  if (!PLACEHOLDER.test(zoneRef)) throw new TypeError("stats time zone SQL: the zone must be a bind placeholder");
}

// SQL: the stored UTC timestamp `column` as wall-clock time in the zone bound
// at `zoneRef` (a placeholder such as "$3"). `column` is code, never input.
export function zonedTimestampSql(column: string, zoneRef: string): string {
  assertPlaceholder(zoneRef);
  return `((${column} AT TIME ZONE 'UTC') AT TIME ZONE ${zoneRef}::text)`;
}

// SQL: midnight of the date `dateExpr` in the zone, as a stored-UTC timestamp.
// Compare the BARE column with it so the startedAt indexes still serve the
// range (a wrapped column can't use them). `dateExpr` is code, never input.
export function zonedMidnightSql(dateExpr: string, zoneRef: string): string {
  assertPlaceholder(zoneRef);
  return `((((${dateExpr})::timestamp) AT TIME ZONE ${zoneRef}::text) AT TIME ZONE 'UTC')`;
}
