// The Radarr/Sonarr monitor: the pure rules. Radarr/Sonarr Connect has no
// trigger for a disk running out of space or a download that failed, and a
// download that gets stuck (import blocked, client error) only shows on the
// arr's own queue screen — so the arr-watch cron polls each configured
// instance and tells the admin's notification channels about each of them.
// Zero I/O; the data half is arr-watch-data.ts.
//
// Two different kinds of thing are judged here, and they are told apart on
// purpose (guardrail 7b):
//   • A low disk is a CONDITION, recomputed every run. It is announced only on
//     a change of state per (instance, disk) — low, then ok again — with a
//     margin before "ok" so a disk hovering at the line can't flap.
//   • A failed download and a download newly needing attention are EVENTS.
//     Each one is sent once, and never held back because a similar one was
//     sent before. "Once" is a cursor over the arr's own history (failures) and
//     a memory of the downloads already announced (queue); neither is a
//     repeat-suppression of the event itself.
//
// What a run doesn't see is not gone. An arr restart reloads its tracked
// downloads (one read shows them pending, or not at all), an unreachable
// download client empties its part of the queue, paging shifts between reads,
// and a flapping NFS root folder drops its disk from the readings. So an
// announced download and a disk's state are REMEMBERED for WATCH_GRACE_MS after
// they disappear: coming back inside it is the same download, the same disk —
// never news.
import type { ArrService } from "./arr-instances";
import type { ArrHistoryEvent } from "./arr-history";
import type { QueueItem } from "./arr-queue";
import type { NotifyEvent } from "./notify-events";
import { diskFor, rootDisk, type ArrDisk, type ArrRootFolder } from "./arr-system";
import { safeMessage } from "./arr-parse";

// ── settings ─────────────────────────────────────────────────────────────────

/** Percent of a disk that must stay free; below it the disk is "low". */
export const ARR_WATCH_DISK_LOW_PERCENT_KEY = "arrWatchDiskLowPercent";
export const DEFAULT_DISK_LOW_PERCENT = 10;
export const MIN_DISK_LOW_PERCENT = 1;
export const MAX_DISK_LOW_PERCENT = 50;

/**
 * A disk with less than this free is low WHATEVER its percentage: that is less
 * than one large release, so the next import fails anyway. It is also the only
 * rule available for a root folder no /diskspace entry holds (a network share
 * Radarr/Sonarr report free space for but no size), where a percentage can't
 * be worked out. Decimal GB, as the arrs and the alert text show sizes.
 */
export const DISK_LOW_FLOOR_BYTES = 10 * 1000 ** 3;
/** A low disk reads "ok" again only this far above the line (both rules), so one that hovers at it can't flap. */
export const DISK_RECOVER_MARGIN_PERCENT = 2;
export const DISK_RECOVER_MARGIN_BYTES = 2 * 1000 ** 3;

/** Write side: a whole number of percent in range, or null. Nothing is repaired on write. */
export function validateDiskLowPercent(raw: unknown): number | null {
  const s = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "";
  if (!/^\d{1,3}$/.test(s)) return null;
  const n = Number(s);
  return n >= MIN_DISK_LOW_PERCENT && n <= MAX_DISK_LOW_PERCENT ? n : null;
}

/** Read side: the stored value, or the default when it is absent or not one the write side accepts. */
export function parseDiskLowPercent(raw: unknown): number {
  return validateDiskLowPercent(raw) ?? DEFAULT_DISK_LOW_PERCENT;
}

// ── instances ────────────────────────────────────────────────────────────────

export interface WatchInstance {
  service: ArrService;
  slug: string;
  /** Registry display name ("Default" for the default instance). */
  name: string;
}

export function instanceStateKey(service: ArrService, slug: string): string {
  return `${service}:${slug}`;
}

// The default instance carries no name in an alert ("Radarr", not "Radarr (Default)").
const instanceNameOf = (inst: WatchInstance): string | null => (inst.slug === "" ? null : inst.name || inst.slug);

// ── free text from upstream ──────────────────────────────────────────────────

const URL_RE = /\bhttps?:\/\/[^\s"'<>]+/gi;
// A path runs to the END OF ITS CLAUSE, never to its first space: media folders
// and file names contain spaces ("Movie Name (2020)/Movie Name (2020).mkv"),
// and cutting there sent the rest of the path to the channel. They also contain
// clause punctuation — "Ocean's Eleven", "Crouching Tiger, Hidden Dragon",
// "Mr. Robot" — so a terminator is read in context:
//   - `"`, `<`, `>`, `]` always end it, and so does "; " (or ";" at the end);
//   - `'` ends it only as a CLOSING quote — not followed by a letter or digit,
//     so the apostrophe in "Ocean's" never does;
//   - ", " / ". " end it only when the NEXT clause doesn't carry on the path:
//     no "/" or "\" and no file extension before the clause after it ends
//     ("Hidden Dragon (2000)/…", "Hidden Dragon (2000).mkv", "Robot/Season 01").
// A clause after the path that happens to hold a slash ("…/x.mkv. Ensure …
// this file/folder") goes with it: removing too much is the safe direction
// (guardrail 7c). Known residual: a trailing-apostrophe name before a space
// ("The Boys' Club/…") still ends there.
const PATH_CLAUSE_GOES_ON = String.raw`(?:(?![;,.](?:\s|$))[^"<>\]\r\n])*?(?:[\\/]|\.[A-Za-z0-9]{2,4}(?![A-Za-z0-9]))`;
const PATH_END = String.raw`(?=["<>\]]|'(?![A-Za-z0-9])|;(?:\s|$)|[,.](?:\s+|$)(?!` + PATH_CLAUSE_GOES_ON + String.raw`)|$)`;
const UNC_PATH_RE = new RegExp(String.raw`\\\\[^"<>\]\r\n]*?` + PATH_END, "g");
const WINDOWS_PATH_RE = new RegExp(String.raw`\b[A-Za-z]:[\\/][^"<>\]\r\n]*?` + PATH_END, "g");
// An absolute POSIX path: a "/" at the start of the text or after a space,
// quote, bracket, colon or equals sign ("1/2" and "and/or" are not paths).
const POSIX_PATH_RE = new RegExp(String.raw`(^|[\s"'([=:])\/[^"<>\]\r\n]*?` + PATH_END, "g");

/**
 * Radarr/Sonarr (or a download client, quoted by them) wrote this: one line,
 * credentials masked (safeMessage), and NO paths or URLs — a failure message
 * routinely names the download's folder, and an indexer's can quote the
 * release URL it tried. A URL keeps only its host.
 */
export function scrubArrText(v: unknown, max = 300): string | null {
  if (typeof v !== "string") return null;
  const s = v
    .replace(/[\r\n\t]+/g, " ")
    .replace(URL_RE, (m) => {
      try {
        return `${new URL(m).host}/…`;
      } catch {
        return "…";
      }
    })
    .replace(UNC_PATH_RE, "…")
    .replace(WINDOWS_PATH_RE, "…")
    .replace(POSIX_PATH_RE, "$1…");
  return safeMessage(s, max);
}

/** How long an announced download, or a disk's state, outlives its disappearing from a read (see the header). */
export const WATCH_GRACE_MS = 24 * 60 * 60_000;

// ── disks ────────────────────────────────────────────────────────────────────

export type DiskState = "low" | "ok";

// rootDisk — which /diskspace entry a root folder can be believed to sit on —
// lives beside diskFor in arr-system.ts, so the Storage tab's sizes and this
// monitor's verdicts come from one rule. Re-exported for this module's callers.
export { DISK_MATCH_TOLERANCE_BYTES, DISK_MATCH_TOLERANCE_RATIO, rootDisk } from "./arr-system";

export interface DiskReading {
  /** The disk's path, or the root folder's own when no /diskspace entry holds it. */
  path: string;
  /** The root folders on it. */
  roots: string[];
  freeBytes: number;
  totalBytes: number | null;
  /** One decimal; null when the size is unknown. */
  freePercent: number | null;
}

const MAX_DISKS = 200;

/**
 * One reading per DISK that holds a root folder — where Radarr/Sonarr write
 * media, so the disks a full one stops imports on. Other mounts the arr lists
 * (its own config volume, tmpfs, the container root) are not judged: they are
 * not where a download lands, and their churn would be noise. Two root folders
 * on one disk are one reading, so one alert. An inaccessible root folder is
 * skipped — that is Radarr/Sonarr's own RootFolder health check (arr.health).
 * A root folder whose disk can't be believed (rootDisk) is its own reading,
 * keyed by its own path, with no size: the 10 GB floor alone judges it — or,
 * reporting no free space of its own either, it is skipped (nothing to judge;
 * never "/"'s free space in its place).
 */
export function readDisks(roots: readonly ArrRootFolder[], disks: readonly ArrDisk[]): DiskReading[] {
  const byPath = new Map<string, DiskReading>();
  for (const root of roots) {
    if (!root.accessible) continue;
    const disk = rootDisk(root, disks);
    const refused = disk === null ? diskFor(root.path, disks) : null;
    const free = root.freeSpace ?? disk?.freeSpace ?? null;
    if (free === null) continue;
    const path = disk?.path ?? root.path;
    // projectRootFolders lends a root folder only a believed disk's size now;
    // kept as defence for a root built elsewhere with the refused disk's size.
    const ownTotal = refused !== null && root.totalSpace === refused.totalSpace ? null : root.totalSpace;
    const total = disk?.totalSpace ?? ownTotal ?? null;
    const existing = byPath.get(path);
    if (existing) {
      existing.roots.push(root.path);
      // Root folders on one disk report the same free space; keep the smaller.
      if (free < existing.freeBytes) existing.freeBytes = free;
      continue;
    }
    if (byPath.size >= MAX_DISKS) break;
    byPath.set(path, { path, roots: [root.path], freeBytes: free, totalBytes: total && total > 0 ? total : null, freePercent: null });
  }
  for (const r of byPath.values()) {
    r.freePercent = r.totalBytes ? Math.round((r.freeBytes / r.totalBytes) * 1000) / 10 : null;
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export function isDiskLow(r: DiskReading, thresholdPercent: number): boolean {
  if (r.freeBytes < DISK_LOW_FLOOR_BYTES) return true;
  return r.totalBytes !== null && (r.freeBytes / r.totalBytes) * 100 < thresholdPercent;
}

export function hasDiskRecovered(r: DiskReading, thresholdPercent: number): boolean {
  if (r.freeBytes < DISK_LOW_FLOOR_BYTES + DISK_RECOVER_MARGIN_BYTES) return false;
  return r.totalBytes === null || (r.freeBytes / r.totalBytes) * 100 >= thresholdPercent + DISK_RECOVER_MARGIN_PERCENT;
}

export interface DiskTransition { reading: DiskReading; to: DiskState }

/** A disk a read no longer listed: its last state, and when it went missing. */
export interface GoneDisk { state: DiskState; at: string }

/**
 * Each disk's state now, and the CHANGES since the last run. A disk seen for
 * the first time that is already low is a change (from unknown) — a disk that
 * is full right now is news even on the first run; one that is fine is not. A
 * disk no longer listed is not announced; with `memory` its state is kept as
 * `gone` for WATCH_GRACE_MS, so one that comes back inside it (a flapping
 * mount, a root folder briefly inaccessible) is judged against that state
 * instead of as a newcomer — a disk still low is not announced again.
 */
export function judgeDisks(
  readings: readonly DiskReading[],
  thresholdPercent: number,
  prev: Readonly<Record<string, DiskState>> | null,
  memory: { gone: Readonly<Record<string, GoneDisk>> | null; nowMs: number } | null = null,
): { next: Record<string, DiskState>; transitions: DiskTransition[]; gone: Record<string, GoneDisk> } {
  const next: Record<string, DiskState> = {};
  const transitions: DiskTransition[] = [];
  const floor = memory ? memory.nowMs - WATCH_GRACE_MS : 0;
  const recalled = (path: string): DiskState | undefined => {
    const g = memory?.gone?.[path];
    return g && Date.parse(g.at) >= floor ? g.state : undefined;
  };
  for (const r of readings) {
    const was = prev?.[r.path] ?? recalled(r.path);
    const now: DiskState = was === "low"
      ? (hasDiskRecovered(r, thresholdPercent) ? "ok" : "low")
      : (isDiskLow(r, thresholdPercent) ? "low" : "ok");
    next[r.path] = now;
    if (now === "low" && was !== "low") transitions.push({ reading: r, to: "low" });
    else if (now === "ok" && was === "low") transitions.push({ reading: r, to: "ok" });
  }
  const gone: Record<string, GoneDisk> = {};
  if (memory) {
    const at = new Date(memory.nowMs).toISOString();
    for (const [path, state] of Object.entries(prev ?? {})) {
      if (!(path in next) && Object.keys(gone).length < MAX_DISKS) gone[path] = { state, at };
    }
    for (const [path, g] of Object.entries(memory.gone ?? {})) {
      if (!(path in next) && !(path in gone) && Date.parse(g.at) >= floor && Object.keys(gone).length < MAX_DISKS) gone[path] = g;
    }
  }
  return { next, transitions, gone };
}

export function diskEvent(inst: WatchInstance, t: DiskTransition, thresholdPercent: number): NotifyEvent {
  return {
    event: t.to === "low" ? "arr.disk_low" : "arr.disk_ok",
    arr: {
      service: inst.service,
      instance: inst.slug,
      instanceName: instanceNameOf(inst),
      path: t.reading.path,
      freeBytes: t.reading.freeBytes,
      totalBytes: t.reading.totalBytes,
      freePercent: t.reading.freePercent,
      thresholdPercent,
    },
  };
}

// ── failed downloads ─────────────────────────────────────────────────────────

/**
 * How far into the arr's history a run reads: the position (date, then id —
 * ids grow with every write) of the last failure record already handled. The
 * dates are the arr's own, so Summonarr's clock matters for the seed and for
 * one bound: a run never consumes a record dated after its own clock, so the
 * cursor it stores never passes it (selectNewFailures).
 */
export interface HistoryCursor { at: string; lastId: number }

/** A download already announced, remembered briefly so its late records fold into that announcement. */
export interface RecentFailure { downloadId: string; at: string }

/** One failed DOWNLOAD — every record sharing its downloadId. */
export interface FailureGroup {
  downloadId: string | null;
  /** The first record's date. */
  at: string;
  release: string;
  mediaTitle: string;
  tmdbId: number | null;
  /** Distinct episodes (Sonarr writes one failed record per episode of a pack). */
  episodes: number;
  /** The first record's message, credentials masked, no paths or URLs. */
  message: string | null;
}

/** A cursor older than this resumes from it: a monitor that was down for days announces only the last day. */
export const MAX_HISTORY_LOOKBACK_MS = 24 * 60 * 60_000;
/**
 * Failed downloads announced per instance per run. The rest are NOT dropped:
 * the cursor stops before them and the next run announces them — a backlog is
 * paced, not lost.
 */
export const MAX_FAILURES_PER_RUN = 25;
/**
 * A pack's per-episode records are written together, but a run can land between
 * them. A record of a download announced this recently (by the arr's dates)
 * folds into that announcement instead of starting a second one.
 */
export const FAILURE_FOLD_WINDOW_MS = 60 * 60_000;
const MAX_RECENT_FAILURES = 200;
/**
 * How far past Summonarr's clock a STORED cursor may sit before
 * `effectiveCursor` restarts it at now (Summonarr's own clock stepped back, or
 * a cursor written by an older build). A tolerance only for the stored value:
 * a run never CONSUMES a record dated after its own clock (selectNewFailures).
 */
export const MAX_FUTURE_SKEW_MS = 60 * 60_000;

/**
 * The cursor a run reads from: the stored one, clamped to the lookback; a first
 * run seeds "now" and reads nothing. A stored cursor further than
 * MAX_FUTURE_SKEW_MS in the future (written before records were held back, or
 * Summonarr's own clock went back) restarts at now — not a day back, which
 * would re-announce failures `recent` no longer remembers.
 */
export function effectiveCursor(stored: HistoryCursor | null, nowMs: number): { cursor: HistoryCursor; seeded: boolean } {
  if (!stored) return { cursor: { at: new Date(nowMs).toISOString(), lastId: 0 }, seeded: true };
  const floor = nowMs - MAX_HISTORY_LOOKBACK_MS;
  const at = Date.parse(stored.at);
  if (!Number.isFinite(at) || at < floor) return { cursor: { at: new Date(floor).toISOString(), lastId: 0 }, seeded: false };
  if (at > nowMs + MAX_FUTURE_SKEW_MS) return { cursor: { at: new Date(nowMs).toISOString(), lastId: 0 }, seeded: false };
  return { cursor: stored, seeded: false };
}

const after = (ms: number, id: number, c: { ms: number; id: number }) => ms > c.ms || (ms === c.ms && id > c.id);

/**
 * The message Radarr's and Sonarr's FailedDownloadService.MarkAsFailed writes
 * on the DownloadFailed record of a MANUAL mark — Summonarr's Mark failed,
 * Blocklist, Blocklist & search and Replace file, or the arr's own UI. That is
 * an admin's action, not a failed download: it is consumed (the cursor passes
 * it) but never announced or counted. An arr wording it differently is simply
 * announced, as before.
 */
const ARR_MANUAL_FAIL_MESSAGE = "manually marked as failed";
const isManualMark = (r: ArrHistoryEvent): boolean => r.message?.trim().toLowerCase() === ARR_MANUAL_FAIL_MESSAGE;

/**
 * The failures past the cursor, folded by downloadId, oldest first, at most
 * `cap` downloads. Returns the cursor to store (the last record consumed) and
 * the remembered downloads. Only "failed" records are read — an arr that
 * ignored the eventType filter can't turn a grab into a failure — and a
 * manual mark (ARR_MANUAL_FAIL_MESSAGE) is consumed silently. A record dated
 * after `nowMs` is HELD BACK — not consumed — until Summonarr's clock reaches
 * it: the arr host's clock jumped forward while it wrote that failure, and
 * consuming it would move the cursor ahead of real time, so every genuine
 * failure the corrected arr writes before that moment would fall behind the
 * cursor, unannounced. (Any tolerance here is a window of exactly that loss —
 * a one-hour one lost up to an hour of failures.) Held back, it is delayed,
 * never lost and never repeated; the cost is that an arr whose clock runs
 * steadily ahead has each failure announced that much later.
 * Records of one download fold within FAILURE_FOLD_WINDOW_MS of its first
 * record, in one run exactly as across runs. `deferred` counts history RECORDS
 * left for the next run once the cap was reached — a Sonarr pack counts once
 * per episode, so it is not a count of downloads.
 */
export function selectNewFailures(
  records: readonly ArrHistoryEvent[],
  cursor: HistoryCursor,
  recent: readonly RecentFailure[],
  cap = MAX_FAILURES_PER_RUN,
  nowMs = Number.POSITIVE_INFINITY,
): { groups: FailureGroup[]; cursor: HistoryCursor; recent: RecentFailure[]; deferred: number } {
  const c = { ms: Date.parse(cursor.at), id: cursor.lastId };
  const latest = nowMs;
  const fresh = records
    .filter((r) => r.kind === "failed" && r.date !== null)
    .map((r) => ({ r, ms: Date.parse(r.date as string) }))
    .filter((x) => Number.isFinite(x.ms) && x.ms <= latest && after(x.ms, x.r.id, c))
    .sort((a, b) => a.ms - b.ms || a.r.id - b.r.id);

  const groups: FailureGroup[] = [];
  const byDownload = new Map<string, { group: FailureGroup; episodes: Set<string>; ms: number }>();
  const remembered = new Map<string, number>();
  for (const f of recent) {
    const ms = Date.parse(f.at);
    if (Number.isFinite(ms)) remembered.set(f.downloadId, ms);
  }
  let last: { ms: number; id: number; at: string } | null = null;
  let consumed = 0;
  for (const { r, ms } of fresh) {
    const id = r.downloadId;
    const open = id ? byDownload.get(id) : undefined;
    if (isManualMark(r)) {
      // An admin's mark, not a failure: passed, never announced (before the cap, so it can't use up the budget).
    } else if (open && ms - open.ms <= FAILURE_FOLD_WINDOW_MS) {
      if (r.episode) open.episodes.add(`${r.episode.seasonNumber}:${r.episode.episodeNumber}`);
      else if (r.episodeId !== null) open.episodes.add(`id:${r.episodeId}`);
      open.group.episodes = open.episodes.size;
    } else if (id && remembered.has(id) && Math.abs(ms - (remembered.get(id) as number)) <= FAILURE_FOLD_WINDOW_MS) {
      // Part of a download a previous run already announced.
    } else {
      if (groups.length >= cap) break;
      const group: FailureGroup = {
        downloadId: id,
        at: new Date(ms).toISOString(),
        release: r.sourceTitle,
        mediaTitle: r.mediaTitle,
        tmdbId: r.tmdbId,
        episodes: 0,
        message: scrubArrText(r.message),
      };
      const episodes = new Set<string>();
      if (r.episode) episodes.add(`${r.episode.seasonNumber}:${r.episode.episodeNumber}`);
      else if (r.episodeId !== null) episodes.add(`id:${r.episodeId}`);
      group.episodes = episodes.size;
      groups.push(group);
      if (id) {
        byDownload.set(id, { group, episodes, ms });
        remembered.set(id, ms);
      }
    }
    last = { ms, id: r.id, at: new Date(ms).toISOString() };
    consumed++;
  }

  const nextCursor = last ? { at: last.at, lastId: last.id } : cursor;
  const horizon = Date.parse(nextCursor.at) - FAILURE_FOLD_WINDOW_MS;
  const nextRecent = [...remembered.entries()]
    .filter(([, ms]) => ms >= horizon)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_RECENT_FAILURES)
    .map(([downloadId, ms]) => ({ downloadId, at: new Date(ms).toISOString() }));
  return { groups, cursor: nextCursor, recent: nextRecent, deferred: fresh.length - consumed };
}

export function failureEvent(inst: WatchInstance, g: FailureGroup): NotifyEvent {
  const mediaType = inst.service === "radarr" ? "MOVIE" : "TV";
  return {
    event: "arr.download_failed",
    ...(g.mediaTitle ? { media: { type: mediaType, tmdbId: g.tmdbId, title: g.mediaTitle } } : {}),
    text: g.message,
    arr: {
      service: inst.service,
      instance: inst.slug,
      instanceName: instanceNameOf(inst),
      release: g.release || null,
      downloadId: g.downloadId,
      episodes: inst.service === "sonarr" && g.episodes > 0 ? g.episodes : null,
    },
  };
}

// ── downloads needing attention ──────────────────────────────────────────────

const MAX_ATTENTION_KEYS = 2_000;
/**
 * Downloads announced as newly needing attention, per instance per run — a
 * whole queue blocked at once (a full disk, a client gone) would otherwise be
 * one message per download. The rest are NOT dropped: they are not remembered
 * as announced, so the next run announces them.
 */
export const MAX_ATTENTION_PER_RUN = 25;

/** A download's identity in the queue — the same identity foldQueueRecords folds a Sonarr pack on. */
export function attentionKey(item: QueueItem): string {
  return item.downloadId ? `d:${item.downloadId}:${item.arrMediaId ?? ""}` : `q:${Math.min(...item.ids)}`;
}

/** What the previous runs know of an instance's attention set. */
export interface AttentionMemory {
  /** The keys in attention at the last read (the summary's count). */
  keys?: readonly string[];
  /** Keys already announced (or seeded) → when each was last seen needing attention. */
  seen?: Readonly<Record<string, string>>;
  /** When the queue was last read successfully (InstanceWatchState.attentionReadAt). */
  readAt?: string;
}

/**
 * A gap between two successful queue reads longer than this is UNOBSERVED
 * time (the arr unreachable, Summonarr down) and does not age the attention
 * memory: a download stuck through a 26-hour outage is not "newly stuck" on
 * recovery. Well above the default 15-minute cadence and the 5-minute retry,
 * so regular runs age exactly as before. The floor only — the gap the monitor
 * uses scales with its configured cadence (`attentionReadGapMs`).
 */
export const ATTENTION_READ_GAP_MS = 60 * 60_000;

/**
 * The read gap for a cadence of `intervalSeconds` (ARR_WATCH_INTERVAL): twice
 * the interval, never under ATTENTION_READ_GAP_MS. A FIXED hour made every
 * regular gap of a slower cadence "unobserved" — at a daily interval each run
 * moved the kept keys forward ~23 h, so the 24-hour memory lasted ~25 days.
 */
export function attentionReadGapMs(intervalSeconds: number): number {
  return Math.max(ATTENTION_READ_GAP_MS, 2 * intervalSeconds * 1000);
}

/**
 * The downloads in attention now, and those not announced before. A download
 * is remembered for WATCH_GRACE_MS after it was last seen needing attention —
 * whether it then dropped off the queue or read as fine for a while — so
 * coming back inside that is not "newly stuck". At most `cap` are announced per
 * run; the rest stay unremembered and are announced by the next. With no
 * previous state (the first run for this instance) nothing is new: downloads
 * already stuck when the monitor started are on the queue page and the nav
 * badge, not announced as if they just happened. A state stored before the
 * memory existed knows its last set, and that set seeds it. The grace counts
 * OBSERVED time only: the part of the gap since the last successful read
 * (`readAt`) beyond `readGapMs` (the cadence's `attentionReadGapMs`) is not
 * counted, and a key kept through it is stored moved forward by that much, so
 * later runs don't count it either.
 */
export function diffAttention(
  items: readonly QueueItem[],
  prev: AttentionMemory | null,
  nowMs: number,
  cap = MAX_ATTENTION_PER_RUN,
  readGapMs = ATTENTION_READ_GAP_MS,
): { keys: string[]; newly: QueueItem[]; seen: Record<string, string>; deferred: number } {
  const nowIso = new Date(nowMs).toISOString();
  const lastRead = prev?.readAt ? Date.parse(prev.readAt) : NaN;
  const unobserved = Number.isFinite(lastRead) ? Math.max(0, nowMs - lastRead - readGapMs) : 0;
  const floor = nowMs - WATCH_GRACE_MS - unobserved;
  const known = new Map<string, string>();
  for (const [key, at] of Object.entries(prev?.seen ?? {})) {
    const ms = Date.parse(at);
    if (ms >= floor) known.set(key, unobserved > 0 ? new Date(Math.min(nowMs, ms + unobserved)).toISOString() : at);
  }
  if (prev && !prev.seen) for (const key of prev.keys ?? []) known.set(key, nowIso);
  const keys: string[] = [];
  const newly: QueueItem[] = [];
  let deferred = 0;
  for (const item of items) {
    if (!item.attention) continue;
    const key = attentionKey(item);
    if (keys.length < MAX_ATTENTION_KEYS) keys.push(key);
    if (prev === null || known.has(key)) {
      known.set(key, nowIso);
    } else if (newly.length >= cap) {
      deferred++;
    } else {
      newly.push(item);
      known.set(key, nowIso);
    }
  }
  // Newest first, so a bound drops the longest-unseen.
  const seen = Object.fromEntries([...known.entries()].sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0)).slice(0, MAX_ATTENTION_KEYS));
  return { keys, newly, seen, deferred };
}

export function attentionEvent(inst: WatchInstance, item: QueueItem): NotifyEvent {
  const mediaType = inst.service === "radarr" ? "MOVIE" : "TV";
  const text = item.messages.slice(0, 2).map((m) => scrubArrText(m, 200)).filter((m): m is string => !!m).join("; ");
  return {
    event: "arr.queue_attention",
    ...(item.mediaTitle ? { media: { type: mediaType, tmdbId: item.tmdbId, title: item.mediaTitle } } : {}),
    text: text || null,
    arr: {
      service: inst.service,
      instance: inst.slug,
      instanceName: instanceNameOf(inst),
      release: item.title || null,
      downloadId: item.downloadId,
      episodes: inst.service === "sonarr" && item.episodes.length > 0 ? item.episodes.length : null,
      arrId: item.arrMediaId,
    },
  };
}

// ── state ────────────────────────────────────────────────────────────────────

/** Everything one instance's next run needs. An absent part means "never read" (the next read seeds it). */
export interface InstanceWatchState {
  disks?: Record<string, DiskState>;
  /** Disks a read stopped listing, remembered for WATCH_GRACE_MS (judgeDisks). */
  goneDisks?: Record<string, GoneDisk>;
  history?: { cursor: HistoryCursor; recent: RecentFailure[] };
  attention?: string[];
  /** Announced attention keys → last seen needing attention (diffAttention). */
  attentionSeen?: Record<string, string>;
  /** The last SUCCESSFUL queue read — a failed read keeps it, so the gap counts as unobserved (diffAttention). */
  attentionReadAt?: string;
  /** When each announced failed download failed, for the last 24 hours (the summary's count). */
  failures?: string[];
}

export interface ArrWatchState { instances: Record<string, InstanceWatchState> }

export const FAILURE_COUNT_WINDOW_MS = 24 * 60 * 60_000;
const MAX_FAILURE_TIMES = 1_000;

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Raw) : null);
const isIso = (v: unknown): v is string => typeof v === "string" && v.length <= 40 && Number.isFinite(Date.parse(v));
const strings = (v: unknown, max: number): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length <= 600).slice(0, max) : [];

function parseInstanceState(v: unknown): InstanceWatchState | null {
  const r = obj(v);
  if (!r) return null;
  const out: InstanceWatchState = {};
  const disks = obj(r.disks);
  if (disks) {
    out.disks = {};
    for (const [path, state] of Object.entries(disks)) {
      if ((state === "low" || state === "ok") && Object.keys(out.disks).length < MAX_DISKS) out.disks[path] = state;
    }
  }
  const history = obj(r.history);
  const cursor = obj(history?.cursor);
  if (history && cursor && isIso(cursor.at) && typeof cursor.lastId === "number" && Number.isSafeInteger(cursor.lastId) && cursor.lastId >= 0) {
    const recent: RecentFailure[] = [];
    for (const x of Array.isArray(history.recent) ? history.recent : []) {
      const f = obj(x);
      if (f && typeof f.downloadId === "string" && f.downloadId.length <= 200 && isIso(f.at)) recent.push({ downloadId: f.downloadId, at: f.at });
      if (recent.length >= MAX_RECENT_FAILURES) break;
    }
    out.history = { cursor: { at: cursor.at, lastId: cursor.lastId }, recent };
  }
  const gone = obj(r.goneDisks);
  if (gone) {
    out.goneDisks = {};
    for (const [path, v] of Object.entries(gone)) {
      const g = obj(v);
      if (g && (g.state === "low" || g.state === "ok") && isIso(g.at) && Object.keys(out.goneDisks).length < MAX_DISKS) {
        out.goneDisks[path] = { state: g.state, at: g.at };
      }
    }
  }
  if (Array.isArray(r.attention)) out.attention = strings(r.attention, MAX_ATTENTION_KEYS);
  const seen = obj(r.attentionSeen);
  if (seen) {
    out.attentionSeen = {};
    for (const [key, at] of Object.entries(seen)) {
      if (key.length <= 600 && isIso(at) && Object.keys(out.attentionSeen).length < MAX_ATTENTION_KEYS) out.attentionSeen[key] = at;
    }
  }
  if (isIso(r.attentionReadAt)) out.attentionReadAt = r.attentionReadAt;
  if (Array.isArray(r.failures)) out.failures = strings(r.failures, MAX_FAILURE_TIMES).filter(isIso);
  return out;
}

/** Defensive: a corrupt or hand-edited snapshot reads as "nothing known" (every part re-seeds), never as an error. */
export function parseArrWatchState(raw: string | null | undefined): ArrWatchState {
  const state: ArrWatchState = { instances: {} };
  if (!raw) return state;
  try {
    const instances = obj(obj(JSON.parse(raw))?.instances);
    for (const [key, v] of Object.entries(instances ?? {})) {
      const parsed = parseInstanceState(v);
      if (parsed) state.instances[key] = parsed;
    }
  } catch {
    // unparseable — start over
  }
  return state;
}

/** The failure times to keep: the last 24 hours, newest last, bounded. */
export function recentFailureTimes(prev: readonly string[] | undefined, added: readonly string[], nowMs: number): string[] {
  const floor = nowMs - FAILURE_COUNT_WINDOW_MS;
  return [...(prev ?? []), ...added]
    .filter((at) => Date.parse(at) >= floor)
    .sort()
    .slice(-MAX_FAILURE_TIMES);
}

// ── summary (the nav badge, the settings card) ───────────────────────────────

export interface ArrWatchCounts {
  /** Downloads Radarr/Sonarr say need an admin, across every instance. */
  attention: number;
  /** Disks below the line. */
  lowDisks: number;
  /** Failed downloads announced in the last 24 hours. */
  failed24h: number;
}

export interface ArrWatchSummary extends ArrWatchCounts { at: string }

export function summarize(state: ArrWatchState, nowMs: number): ArrWatchCounts {
  const floor = nowMs - FAILURE_COUNT_WINDOW_MS;
  let attention = 0;
  let lowDisks = 0;
  let failed24h = 0;
  for (const s of Object.values(state.instances)) {
    attention += s.attention?.length ?? 0;
    lowDisks += Object.values(s.disks ?? {}).filter((d) => d === "low").length;
    failed24h += (s.failures ?? []).filter((at) => Date.parse(at) >= floor).length;
  }
  return { attention, lowDisks, failed24h };
}

const count = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null);

export function parseArrWatchSummary(raw: string | null | undefined): ArrWatchSummary | null {
  if (!raw) return null;
  try {
    const r = obj(JSON.parse(raw));
    const attention = count(r?.attention);
    const lowDisks = count(r?.lowDisks);
    const failed24h = count(r?.failed24h);
    if (!r || !isIso(r.at) || attention === null || lowDisks === null || failed24h === null) return null;
    return { at: r.at, attention, lowDisks, failed24h };
  } catch {
    return null;
  }
}

/**
 * The Download Queue badge: the attention count, or null (no badge) when there
 * is none or the snapshot is older than `maxAgeMs` — a monitor that stopped
 * running must not leave a count up forever.
 */
export function queueBadgeCount(summary: ArrWatchSummary | null, nowMs: number, maxAgeMs: number): number | null {
  if (!summary || summary.attention <= 0) return null;
  return nowMs - Date.parse(summary.at) > maxAgeMs ? null : summary.attention;
}

/** The cron's own interval (ARR_WATCH_INTERVAL, seconds), parsed as docker-entrypoint.sh's _cron_int does. */
export const DEFAULT_ARR_WATCH_INTERVAL_SECONDS = 900;
export function arrWatchIntervalSeconds(raw: string | undefined): number {
  return raw !== undefined && /^(0|[1-9]\d*)$/.test(raw) && Number(raw) > 0 ? Number(raw) : DEFAULT_ARR_WATCH_INTERVAL_SECONDS;
}
