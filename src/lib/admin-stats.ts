// Admin Statistics — the pure half: range parsing, disk de-duplication and the
// small arithmetic the page shares with GET /api/admin/stats. Zero imports, so
// the unit suite exercises it without a database. The prisma half is
// admin-stats-data.ts.

// ─── Range ──────────────────────────────────────────────────────────────────

// The period filter on /admin/stats. "all" is the default because the page was
// all-time before the filter existed, and the native client still reads the
// all-time figures from the API.
export const STATS_RANGES = ["30", "90", "365", "all"] as const;
export type StatsRange = (typeof STATS_RANGES)[number];
export const DEFAULT_STATS_RANGE: StatsRange = "all";

export function parseStatsRange(raw: string | null | undefined): StatsRange {
  return (STATS_RANGES as readonly string[]).includes(raw ?? "") ? (raw as StatsRange) : DEFAULT_STATS_RANGE;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Lower bound on createdAt for the windowed figures; null means all time.
export function statsRangeSince(range: StatsRange, now: Date): Date | null {
  if (range === "all") return null;
  return new Date(now.getTime() - Number(range) * DAY_MS);
}

// ─── Fulfillment ─────────────────────────────────────────────────────────────

// An approval stamped within this many seconds of the request's creation was
// made BY the creation — auto-approve writes approvedAt in the same transaction
// (bulk precomputes `now`, so it can even land a few ms BEFORE createdAt, hence
// the absolute value). Anything slower was a decision somebody made.
export const AUTO_APPROVE_WINDOW_SECONDS = 2;

// A request "waits" in the pending queue past these ages.
export const PENDING_AGE_WARN_DAYS = 3;
export const PENDING_AGE_ALERT_DAYS = 7;

// An APPROVED request Radarr/Sonarr still lists as wanted after this long is
// reported as a slow download.
export const STUCK_DOWNLOAD_DAYS = 7;

// A duration in seconds rendered as the largest unit that keeps it readable.
// Returns the unit and a value; the page owns the wording (i18n).
export type DurationUnit = "minutes" | "hours" | "days";
export function durationParts(seconds: number): { unit: DurationUnit; value: number } {
  const hours = seconds / 3600;
  if (hours < 1) return { unit: "minutes", value: Math.max(0, Math.round(seconds / 60)) };
  if (hours < 24) return { unit: "hours", value: Math.round(hours * 10) / 10 };
  return { unit: "days", value: Math.round((hours / 24) * 10) / 10 };
}

// n / d as a 0–1 share, or null when there is nothing to divide by (a rate over
// zero decisions is not 0%, it is no answer).
export function share(n: number, d: number): number | null {
  return d > 0 ? n / d : null;
}

// ─── Disk ───────────────────────────────────────────────────────────────────

export interface DiskEntryInput {
  path: string;
  label?: string;
  totalSpace: number;
  freeSpace: number;
}

export interface DiskGroupInput {
  // Display name of the reporting instance, e.g. "Radarr" or "Sonarr (Anime)".
  source: string;
  entries: DiskEntryInput[];
}

export interface MergedDisk {
  path: string;
  label: string;
  totalSpace: number;
  freeSpace: number;
  usedPct: number;
  // Every instance that reported this mount, in the order they were given.
  reportedBy: string[];
}

// Radarr and Sonarr on one host — or two instances of either — report the same
// mounts. One disk is one row: keyed by path AND size, so two different volumes
// mounted at the same path inside two containers stay separate.
export function mergeDiskGroups(groups: readonly DiskGroupInput[]): MergedDisk[] {
  const merged = new Map<string, MergedDisk>();
  for (const g of groups) {
    for (const e of g.entries) {
      if (!(e.totalSpace > 0)) continue;
      const key = `${e.path}\u0000${e.totalSpace}`;
      const existing = merged.get(key);
      if (existing) {
        if (!existing.reportedBy.includes(g.source)) existing.reportedBy.push(g.source);
        // Two readings of one disk taken moments apart: keep the lower free
        // figure so the bar never under-reports how full it is.
        if (e.freeSpace < existing.freeSpace) {
          existing.freeSpace = Math.max(0, e.freeSpace);
          existing.usedPct = diskUsedPct(existing.totalSpace, existing.freeSpace);
        }
        continue;
      }
      const freeSpace = Math.max(0, e.freeSpace);
      merged.set(key, {
        path: e.path,
        label: e.label || e.path,
        totalSpace: e.totalSpace,
        freeSpace,
        usedPct: diskUsedPct(e.totalSpace, freeSpace),
        reportedBy: [g.source],
      });
    }
  }
  return [...merged.values()].sort((a, b) => b.usedPct - a.usedPct || a.label.localeCompare(b.label));
}

// Percentage used, clamped to 0–100: a disk reporting more free space than its
// total (seen on some network mounts) must not draw a negative bar.
export function diskUsedPct(totalSpace: number, freeSpace: number): number {
  if (!(totalSpace > 0)) return 0;
  const pct = ((totalSpace - freeSpace) / totalSpace) * 100;
  return Math.min(100, Math.max(0, pct));
}

// ─── Months ─────────────────────────────────────────────────────────────────

// "YYYY-MM" of a date, in UTC — the bucket the SQL month series uses.
export function utcMonthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
