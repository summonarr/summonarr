// Reads the statistics time zone setting (the rule is in stats-time-zone.ts).
// Every statistics query and every page that labels one goes through
// getStatsTimeZone(), so the buckets and their labels always name one zone.
import { prisma } from "./prisma";
import { processSingleton } from "./process-singleton";
import { forgetWarnOnChange, warnOnChange } from "./log-dedup";
import { STATS_TIME_ZONE_KEY, processTimeZone, resolveStatsTimeZone } from "./stats-time-zone";

const CACHE_TTL_MS = 15_000;
const READ_WARNING = "stats-time-zone:read";

// Process-wide (27a): the settings route invalidates it in its chunk, and the
// stats pages and routes read it in theirs.
const state = processSingleton("stats-time-zone:cache", () => ({
  cached: null as { stored: string | null; expiresAt: number } | null,
  inflight: null as Promise<string | null> | null,
  // Bumped by invalidateStatsTimeZone(): a read that began before it is not stored.
  generation: 0,
}));

async function readStored(): Promise<string | null> {
  const generation = state.generation;
  const row = await prisma.setting.findUnique({
    where: { key: STATS_TIME_ZONE_KEY },
    select: { value: true },
  });
  const stored = row?.value || null;
  forgetWarnOnChange(READ_WARNING);
  if (generation === state.generation) {
    state.cached = { stored, expiresAt: Date.now() + CACHE_TTL_MS };
  }
  return stored;
}

// The zone the statistics bucket in right now. Cached briefly; the stored value
// is re-resolved on every call so a TZ change applies to an unset setting at once.
export async function getStatsTimeZone(): Promise<string> {
  const cached = state.cached;
  if (cached && cached.expiresAt > Date.now()) return resolveStatsTimeZone(cached.stored);
  if (!state.inflight) {
    const read = readStored();
    state.inflight = read;
    void read.then(
      () => { if (state.inflight === read) state.inflight = null; },
      () => { if (state.inflight === read) state.inflight = null; },
    );
  }
  try {
    return resolveStatsTimeZone(await state.inflight);
  } catch (err) {
    // The statistics queries that follow need the database too, so they fail on
    // their own; a label read alone should not take a page down.
    const fallback = processTimeZone();
    const reason = err instanceof Error ? err.message : String(err);
    warnOnChange(
      READ_WARNING,
      `${fallback}|${reason}`,
      `[stats-time-zone] Could not read ${STATS_TIME_ZONE_KEY}; using ${fallback}: ${reason}`,
    );
    return fallback;
  }
}

// Whether Postgres can bucket in `zone`. Intl and the database each carry their
// own copy of the time zone database, and a name only Intl knows would make
// every statistics query fail, so a save checks both. Postgres matches zone
// names case-insensitively, as here.
export async function databaseKnowsTimeZone(zone: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ known: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM pg_timezone_names WHERE lower(name) = lower(${zone})) AS known`;
  return rows[0]?.known === true;
}

// After a save or a restore, so a new zone applies on the next request.
export function invalidateStatsTimeZone(): void {
  state.generation++;
  state.cached = null;
  state.inflight = null;
}
