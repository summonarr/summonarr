// The play-history Settings every part of the module reads: the tracking
// switches, the watched/completion thresholds, the arc gap, retention and the
// tracking stamps. One Setting.findMany serves every getter for 15 s.
import { prisma } from "./prisma";
import { processSingleton } from "./process-singleton";

const SETTING_KEYS = [
  "playHistoryEnabled",
  "playHistoryPlexEnabled",
  "playHistoryJellyfinEnabled",
  "playHistoryWatchedThreshold",
  "playHistoryCompletionThreshold",
  "playHistoryArcGapDays",
  "playHistoryRetentionDays",
  // The tracking switches' last off→on stamps (TRACKING_STAMP_KEYS, written by
  // /api/settings): the Statistics delta's coverage check reads them.
  "playHistoryTrackedSince",
  "playHistoryPlexTrackedSince",
  "playHistoryJellyfinTrackedSince",
] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];
export type PlayHistorySettings = Record<SettingKey, string | null>;

const SETTING_KEY_SET: ReadonlySet<string> = new Set(SETTING_KEYS);
function isSettingKey(key: string): key is SettingKey {
  return SETTING_KEY_SET.has(key);
}

const SETTINGS_CACHE_TTL = 15_000;

// Process-wide (guardrail 27a): the module is compiled into the poller's route
// chunk, the pages and the cron routes, and a per-chunk copy meant each chunk
// served its own stale config and an invalidation reached only one of them.
// `generation` drops a read that began before an invalidation.
const settingsState = processSingleton("play-history:settings", () => ({
  cached: null as { values: PlayHistorySettings; expiresAt: number } | null,
  inflight: null as Promise<PlayHistorySettings> | null,
  generation: 0,
}));

export async function loadSettings(): Promise<PlayHistorySettings> {
  const cached = settingsState.cached;
  if (cached && cached.expiresAt > Date.now()) return cached.values;
  if (settingsState.inflight) return settingsState.inflight;
  const generation = settingsState.generation;
  const read = (async () => {
    const rows = await prisma.setting.findMany({
      where: { key: { in: [...SETTING_KEYS] } },
      select: { key: true, value: true },
    });
    const values = Object.fromEntries(SETTING_KEYS.map((k) => [k, null])) as PlayHistorySettings;
    for (const row of rows) {
      if (isSettingKey(row.key)) values[row.key] = row.value ?? null;
    }
    if (generation === settingsState.generation) {
      settingsState.cached = { values, expiresAt: Date.now() + SETTINGS_CACHE_TTL };
    }
    return values;
  })();
  settingsState.inflight = read;
  try {
    return await read;
  } finally {
    if (settingsState.inflight === read) settingsState.inflight = null;
  }
}

// For the settings save and a restore: the next read sees the new values
// instead of serving the old ones for up to SETTINGS_CACHE_TTL.
export function invalidatePlayHistorySettings(): void {
  settingsState.generation++;
  settingsState.cached = null;
  settingsState.inflight = null;
}

// An integer setting inside [min, max], else `fallback` (unset, junk or out of range).
function boundedInt(raw: string | null, min: number, max: number, fallback: number): number {
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

export async function isPlayHistoryEnabled(): Promise<boolean> {
  return (await loadSettings()).playHistoryEnabled === "true";
}

export async function isSourceEnabled(source: "plex" | "jellyfin"): Promise<boolean> {
  const settings = await loadSettings();
  const val = source === "plex" ? settings.playHistoryPlexEnabled : settings.playHistoryJellyfinEnabled;
  return val === "true";
}

// Per-session: the share of the content one sitting must play to be `watched`.
export async function getWatchedThreshold(): Promise<number> {
  return boundedInt((await loadSettings()).playHistoryWatchedThreshold, 0, 100, 80);
}

// Cumulative-watch threshold for an ARC to count as a completion (Popular on
// Server, the Statistics completion rate). Stricter than getWatchedThreshold
// (per-session) — a "completion" should mean they basically finished it. It is
// not the per-session `completed` flag, which marks the playhead reaching the
// end (SESSION_COMPLETED_RATIO in play-history-record.ts).
export async function getCompletionThreshold(): Promise<number> {
  return boundedInt((await loadSettings()).playHistoryCompletionThreshold, 0, 100, 90);
}

// Gap (days) between consecutive sessions on the same media that splits one arc from the next.
// A weekend chunked watch stays one arc; a months-later rewatch starts a new arc.
export async function getArcGapDays(): Promise<number> {
  return boundedInt((await loadSettings()).playHistoryArcGapDays, 1, 365, 14);
}

// The playHistoryRetentionDays setting as a day count; 0 = keep forever (unset,
// zero, negative or junk). The one parse every retention reader shares.
export function retentionDaysFrom(raw: string | null): number {
  const days = raw ? parseInt(raw, 10) : 0;
  return Number.isFinite(days) && days > 0 ? days : 0;
}

// The moment before which retention deletes recorded plays (null = keep
// forever). Nothing before it can be evidence, so the never-watched verdict
// never lets a window start earlier (guardrail 14d).
export async function getRetentionCutoff(now: Date): Promise<Date | null> {
  const days = retentionDaysFrom((await loadSettings()).playHistoryRetentionDays);
  if (days === 0) return null;
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}
