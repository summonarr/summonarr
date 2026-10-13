// "Why is this request stuck?" — the pure half. Judges one APPROVED request
// from what its own Radarr/Sonarr instance reports for the title (the library
// resource, the queue, the DownloadFailed and import history), whether a
// media server the requester can see holds it and whether the requester has a
// media-server preference, then projects the answer COARSELY: the
// request queue's MANAGE_REQUESTS delegates read it too, so no output path,
// download id, download client or indexer name, release title or arr URL ever
// leaves the server (guardrail 5e). Zero I/O; the data half is
// request-arr-status-data.ts.
//
// One primary verdict, the FIRST that holds in this order:
//
//   unreachable        the title read failed — nothing else can be judged
//   ready              a library row the requester can see holds it, and the
//                      sync's own rule lets that mark it: always for a movie
//                      or a title the arr doesn't track, for a series only
//                      once Sonarr calls it complete (guardrail 14a's gate,
//                      sonarrIncompleteKeys) — nothing is stuck; the next
//                      sync marks it available
//   notInArr           the instance doesn't have the title (Re-push)
//   inArrNotInLibrary  the arr has everything, no library row — the sync's
//                      Radarr/Sonarr marking pass marks it available on its
//                      next run, scanned or not. That pass flips ONLY a
//                      requester with no media-server preference
//                      (User.mediaServer); for one with a preference it is
//   waitingForLibrary  instead: the request turns available only once a
//                      library they can see holds the title (the library
//                      marking pass), so it waits on a scan, not a sync
//   unreachable        the queue read failed (only read past this point)
//   importBlocked      a queue item the arr itself says needs attention
//   downloading        the queue has the title
//   unmonitored        nothing is searching for it (Re-push re-monitors).
//                      A Sonarr series monitored at the SERIES level counts
//                      too when nothing under it is: no aired regular episode
//                      monitored or on disk, no monitored airing ahead
//                      (nothingMonitoredToSearch) — `monitored` stays true so
//                      the panel can say so, and Re-push is not offered (it
//                      re-monitors only an unmonitored series)
//   notReleased        movie: no physical/digital date passed; series: no
//                      regular-season episode has aired
//   unreachable        the history read failed (failures; imports once a
//                      failure needs them)
//   downloadFailed     a DownloadFailed event since the request's approval
//                      with no import of the title at or after it — a later
//                      successful download (Sonarr's partial pack, a re-grab)
//                      answers it, and the title is incomplete or waiting
//   incomplete         Sonarr has some episodes, not every aired one
//   waiting            monitored, released, nothing queued, nothing failed
//
// Why that order:
//   • "Ready" mirrors the library marking pass, so the panel never calls a
//     title stuck that the next sync is about to mark available.
//   • "Has everything" comes before the queue: a movie with its file, or a
//     series sonarrSeriesCompletion calls complete (guardrail 14a — the ONE
//     completion rule, never a private threshold), is not waiting on any
//     download. Anything still queued is an upgrade, and reporting it would
//     send the admin after the wrong thing.
//   • The queue comes before monitoring and release dates: a download in
//     flight is the current truth whatever the title's settings say, and one
//     that needs attention is the most actionable answer there is.
//   • Unmonitored comes before not-released: once the title is released,
//     nothing will search for it anyway.
//   • A failure only explains a title with nothing queued — a new grab after
//     a failure is "downloading".
import type { ArrErrorKind } from "./arr-error-kind";
import type { ArrHistoryEvent } from "./arr-history";
import { arrDateMs, missingMovie } from "./arr-missing";
import { safeMessage } from "./arr-parse";
import type { QueueItem, QueuePhase } from "./arr-queue";
import { projectTitle, type ArrService, type ArrTitle } from "./arr-title";
import { sonarrSeriesCompletion, type SonarrSeriesStatsRow } from "./sonarr-completion";

export const ARR_STATUS_VERDICTS = [
  "unreachable",
  "notInArr",
  "ready",
  "inArrNotInLibrary",
  "waitingForLibrary",
  "importBlocked",
  "downloading",
  "unmonitored",
  "notReleased",
  "downloadFailed",
  "incomplete",
  "waiting",
] as const;
export type ArrStatusVerdict = (typeof ARR_STATUS_VERDICTS)[number];

/** One read the verdict depends on: its value, or the class of its failure. */
export type ArrRead<T> = { ok: true; value: T } | { ok: false; kind: ArrErrorKind };

/** One download of the title, as much as a delegate may see. */
export interface ArrStatusDownload {
  phase: QueuePhase;
  /** A release Radarr/Sonarr are holding back (delay profile, client unavailable). */
  pending: boolean;
  /** 0..1. */
  progress: number;
  timeLeftSeconds: number | null;
  estimatedCompletion: string | null;
  /** Radarr/Sonarr's own "an admin should look" verdict (arr-queue.ts needsAttention). */
  attention: boolean;
  /** What the arr says is wrong — credentials, paths, file names and the release's own names removed. */
  messages: string[];
  quality: string | null;
  /** Sonarr: the episodes this download carries. 0 on a movie. */
  episodes: number;
}

export interface RequestArrStatus {
  verdict: ArrStatusVerdict;
  service: ArrService;
  /** Why a read failed, when the verdict is `unreachable`. */
  errorKind: ArrErrorKind | null;
  /** The arr's own settings and state; null when the title wasn't read. */
  monitored: boolean | null;
  hasFile: boolean | null;
  released: boolean | null;
  /** Movie: the earlier of its past physical/digital dates. */
  releasedAt: string | null;
  /** Movie: its next physical/digital date. Series: its next airing. */
  expectedAt: string | null;
  /** Sonarr's regular-season counts (guardrail 14a): episodes with a file of the ones that count. */
  episodes: { withFile: number; total: number } | null;
  /** A Plex/Jellyfin library the requester can see holds the title. */
  inLibrary: boolean;
  /** At most MAX_DOWNLOADS, the ones needing attention first. */
  downloads: ArrStatusDownload[];
  downloadCount: number;
  /**
   * Failed DOWNLOADS since `since` (Sonarr's per-episode records of one pack
   * fold into one — countFailedDownloads), the latest record's date and message.
   */
  failures: { count: number; lastAt: string | null; message: string | null };
  /** The request's approval (else its creation) — older failures don't count. */
  since: string;
  checkedAt: string;
}

export const MAX_DOWNLOADS = 5;
const MAX_MESSAGES = 3;
const MAX_MESSAGE_LEN = 300;
/**
 * Records of one download failing are written together (Sonarr: one per
 * episode of a pack). The same download id failing again later — a torrent
 * re-grabbed after a failure keeps its info hash — is a second failure.
 */
export const FAILURE_FOLD_WINDOW_MS = 60 * 60_000;

/**
 * How many DOWNLOADS failed: records sharing a downloadId within
 * FAILURE_FOLD_WINDOW_MS of that download's first record are one failure —
 * one failed 10-episode pack is "1 failed download", not 10. A record without
 * a downloadId is its own. Undated records are not counted (the caller already
 * filters by date).
 */
export function countFailedDownloads(events: readonly ArrHistoryEvent[]): number {
  const dated = events
    .map((e) => ({ id: e.downloadId, ms: arrDateMs(e.date) }))
    .filter((x): x is { id: string | null; ms: number } => x.ms !== null)
    .sort((a, b) => a.ms - b.ms);
  const firsts: Array<{ id: string; ms: number }> = [];
  let count = 0;
  for (const x of dated) {
    if (x.id !== null && firsts.some((f) => f.id === x.id && x.ms - f.ms <= FAILURE_FOLD_WINDOW_MS)) continue;
    count++;
    if (x.id !== null) firsts.push({ id: x.id, ms: x.ms });
  }
  return count;
}

// ── facts about the title ────────────────────────────────────────────────────

export interface TitleFacts {
  title: ArrTitle;
  /** Movie: it has its file. Series: sonarrSeriesCompletion says complete. */
  hasEverything: boolean;
  released: boolean;
  releasedAt: string | null;
  expectedAt: string | null;
  episodes: { withFile: number; total: number } | null;
}

const isoOf = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

/**
 * What the arr's own resource says about the title, or null when it carries no
 * usable id. A movie is released when the Missing page would list it without
 * a file (arr-missing.ts — its physical or digital date has passed); a movie
 * with NEITHER date (a back-catalog title Radarr never got home-release dates
 * for) falls back to Radarr's own `isAvailable`, or every such film would read
 * "not released" forever. A series is released once a regular-season episode
 * has aired.
 */
export function titleFacts(service: ArrService, instance: string, raw: unknown, nowMs: number): TitleFacts | null {
  const title = projectTitle(service, instance, raw);
  if (!title) return null;
  if (service === "radarr") {
    const probe = missingMovie(
      { id: title.arrId, hasFile: false, physicalRelease: title.physicalRelease, digitalRelease: title.digitalRelease },
      instance,
      nowMs,
    );
    const dated = title.physicalRelease !== null || title.digitalRelease !== null;
    const upcoming = [arrDateMs(title.physicalRelease), arrDateMs(title.digitalRelease)].filter((ms): ms is number => ms !== null && ms > nowMs);
    return {
      title,
      hasEverything: title.hasFile,
      released: probe !== null || (!dated && title.isAvailable === true),
      releasedAt: probe?.releasedAt ?? null,
      expectedAt: probe === null && upcoming.length > 0 ? isoOf(Math.min(...upcoming)) : null,
      episodes: null,
    };
  }
  const completion = sonarrSeriesCompletion(raw as SonarrSeriesStatsRow);
  // Aired: Sonarr counts an aired, monitored episode (or one with a file), and
  // a season's previousAiring says one aired even when nothing in it is
  // monitored. The series-level previousAiring includes specials, so it is
  // read only when no season carries its own statistics.
  const regular = title.seasons.filter((s) => s.seasonNumber > 0);
  const anyAired = completion.basis === "seasons"
    ? regular.some((s) => s.previousAiring !== null)
    : title.previousAiring !== null;
  return {
    title,
    hasEverything: completion.complete,
    released: completion.episodeCount > 0 || anyAired,
    releasedAt: null,
    expectedAt: title.nextAiring,
    episodes: { withFile: completion.episodeFileCount, total: completion.episodeCount },
  };
}

// ── scrubbing upstream text ──────────────────────────────────────────────────

// A URL — the arr's own address, an indexer's or a client's — or a magnet
// link (its dn= is the release name, its tr= can carry a tracker passkey).
const URL_TEXT = /\b(?:[a-z][a-z0-9+.-]*:\/\/|magnet:\?)[^\s"'<>]+/gi;
// A bare host:port ("sabnzbd.lan:8080/api") — a dotted host, so neither a
// quality name ("Bluray-1080p") nor a time ("12:30") is one.
const HOST_PORT = /\b[a-z0-9-]+(?:\.[a-z0-9-]+)+:\d{2,5}\b\S*/gi;
// An absolute path (POSIX, a drive letter, a UNC share) — "No files found are
// eligible for import in /downloads/complete/Name" names the output path. A
// path runs to the END of the message: release and file names have spaces
// ("/downloads/Show Name S01 1080p WEB-DL-GRP"), so stopping at the first one
// leaked the rest; the reason comes before the path. "…" is a boundary too —
// the tail of a removed private value ("…/Show Name - S01E01") is a path —
// and a lone " / " separator is not a path.
const PATH = /(^|[\s"'(\[=:,…])(?:[A-Za-z]:[\\/]|\\\\|\/(?=[^\s/]))[\s\S]*$/;
const MEDIA_EXT = "mkv|mp4|m4v|avi|mov|wmv|ts|m2ts|iso|img|vob|mpg|mpeg|webm|flv|rar|zip|7z|par2|nzb|torrent|nfo|srt|ass|sub|idx|r\\d{2}";
// A file name the release put on disk ("Name.S01E01.1080p.mkv") — a release name in all but form.
const FILE_NAME = new RegExp(`[^\\s"'<>/\\\\]+\\.(?:${MEDIA_EXT})\\b`, "gi");
// A line that is nothing but a file name ("Show - S01E01 - Pilot WEBDL-1080p.mkv"):
// the arr sends a status entry's title, the file, when it has no message.
const BARE_FILE_NAME = new RegExp(`^[^:]*\\.(?:${MEDIA_EXT})$`, "i");
const ELLIPSIS_RUN = /…(?:\s*…)+/g;

/**
 * Upstream free text a delegate may read: credentials masked (safeMessage), and
 * every URL, path, file name and value the caller names as private (the
 * release title, download id, client, indexer, output path) replaced by "…".
 * A line that is only a file name is dropped.
 */
export function scrubMessage(raw: unknown, privateValues: ReadonlyArray<string | null | undefined>): string | null {
  let s = safeMessage(raw, 2_000);
  if (s === null || BARE_FILE_NAME.test(s)) return null;
  // Longest first, so a value containing another is removed whole.
  const known = privateValues
    .filter((v): v is string => typeof v === "string" && v.trim().length >= 3)
    .map((v) => v.trim())
    .sort((a, b) => b.length - a.length);
  // Case-insensitive: a client may lower-case a download id (a torrent's info hash).
  for (const v of known) s = s.replace(new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "…");
  s = s.replace(URL_TEXT, "…").replace(HOST_PORT, "…").replace(PATH, "$1…").replace(FILE_NAME, "…").replace(ELLIPSIS_RUN, "…").trim();
  if (s === "" || s === "…") return null;
  return s.slice(0, MAX_MESSAGE_LEN);
}

/** One folded queue row → what a delegate may see of it. */
export function projectDownload(item: QueueItem): ArrStatusDownload {
  const privateValues = [item.title, item.downloadId, item.downloadClient, item.indexer, item.outputPath];
  const messages: string[] = [];
  for (const m of item.messages) {
    const s = scrubMessage(m, privateValues);
    if (s !== null && !messages.includes(s)) messages.push(s);
    if (messages.length >= MAX_MESSAGES) break;
  }
  return {
    phase: item.phase,
    pending: item.pending,
    progress: Number.isFinite(item.progress) ? Math.max(0, Math.min(1, item.progress)) : 0,
    timeLeftSeconds: item.timeLeftSeconds,
    estimatedCompletion: item.estimatedCompletion,
    attention: item.attention,
    messages,
    quality: item.quality,
    episodes: item.episodes.length,
  };
}

// ── the verdict ──────────────────────────────────────────────────────────────

export interface ArrStatusInputs {
  service: ArrService;
  instance: string;
  /** The instance's own resource for the title; null when it doesn't have it. */
  resource: ArrRead<Record<string, unknown> | null>;
  /** The title's queue, folded (arr-queue.ts). Null when it was not read. */
  queue: ArrRead<QueueItem[]> | null;
  /** The title's DownloadFailed history events. Null when not read. */
  failures: ArrRead<ArrHistoryEvent[]> | null;
  /** The title's import history events — a failure an import followed is answered. Null when not read. */
  imports: ArrRead<ArrHistoryEvent[]> | null;
  inLibrary: boolean;
  /**
   * The requester has a media-server preference (User.mediaServer): the sync's
   * Radarr/Sonarr marking pass skips them, so only a library row flips the request.
   */
  requesterPinned: boolean;
  /** The request's approval, else its creation. */
  sinceMs: number;
  nowMs: number;
}

/**
 * The next sync marks the request available without any download: the arr has
 * everything, or — for a movie — a library the requester can see holds it
 * (the library marking pass needs nothing from Radarr; a series' library
 * presence is held back by Sonarr's wanted row until it is complete).
 */
export function needsNoDownload(service: ArrService, facts: TitleFacts, inLibrary: boolean): boolean {
  return facts.hasEverything || (service === "radarr" && inLibrary);
}

/**
 * A Sonarr series monitored at the series level with nothing under it to
 * search for. Sonarr searches only MONITORED episodes, and its counts say none
 * qualifies: `episodeCount` is "(monitored AND aired) OR has-file", so 0 means
 * no aired regular episode is monitored and none has a file; `nextAiring`
 * counts monitored episodes only, so null means none is scheduled either. And
 * either something aired (a season's previousAiring includes unmonitored
 * episodes) or every regular season is unmonitored — an arr whose
 * previousAiring leaves unmonitored episodes out would otherwise read it as
 * "not released". The title manager's season switch and a Sonarr add with
 * Monitor: None/Future both leave a series in exactly this state.
 */
export function nothingMonitoredToSearch(service: ArrService, facts: TitleFacts): boolean {
  if (service !== "sonarr" || facts.episodes?.total !== 0 || facts.expectedAt !== null) return false;
  const regular = facts.title.seasons.filter((s) => s.seasonNumber > 0);
  return facts.released || (regular.length > 0 && regular.every((s) => !s.monitored));
}

/** The `unmonitored` verdict for a series monitored at the series level only (nothingMonitoredToSearch). */
export function unmonitoredEpisodesOnly(s: Pick<RequestArrStatus, "verdict" | "service" | "monitored">): boolean {
  return s.verdict === "unmonitored" && s.service === "sonarr" && s.monitored === true;
}

// Reads not taken yet are not "failed": a caller that skipped one past a
// verdict that doesn't need it never reaches the check.
const kindOf = (read: ArrRead<unknown> | null): ArrErrorKind => (read && !read.ok ? read.kind : "other");

export function judgeRequestArrStatus(input: ArrStatusInputs): RequestArrStatus {
  const base: RequestArrStatus = {
    verdict: "waiting",
    service: input.service,
    errorKind: null,
    monitored: null,
    hasFile: null,
    released: null,
    releasedAt: null,
    expectedAt: null,
    episodes: null,
    inLibrary: input.inLibrary,
    downloads: [],
    downloadCount: 0,
    failures: { count: 0, lastAt: null, message: null },
    since: new Date(input.sinceMs).toISOString(),
    checkedAt: new Date(input.nowMs).toISOString(),
  };
  const done = (verdict: ArrStatusVerdict, extra: Partial<RequestArrStatus> = {}): RequestArrStatus => ({ ...base, ...extra, verdict });

  if (!input.resource.ok) return done("unreachable", { errorKind: input.resource.kind });
  const facts = input.resource.value === null ? null : titleFacts(input.service, input.instance, input.resource.value, input.nowMs);
  // Untracked by the arr, nothing holds a library title back.
  if (!facts) return done(input.inLibrary ? "ready" : "notInArr");

  base.monitored = facts.title.monitored;
  base.hasFile = facts.title.hasFile;
  base.released = facts.released;
  base.releasedAt = facts.releasedAt;
  base.expectedAt = facts.expectedAt;
  base.episodes = facts.episodes;

  if (needsNoDownload(input.service, facts, input.inLibrary)) {
    if (input.inLibrary) return done("ready");
    return done(input.requesterPinned ? "waitingForLibrary" : "inArrNotInLibrary");
  }

  if (!input.queue?.ok) return done("unreachable", { errorKind: kindOf(input.queue) });
  const queue = input.queue.value;
  if (queue.length > 0) {
    // Needing attention first, then the furthest along.
    const sorted = [...queue].sort((a, b) => Number(b.attention) - Number(a.attention) || b.progress - a.progress);
    base.downloads = sorted.slice(0, MAX_DOWNLOADS).map(projectDownload);
    base.downloadCount = queue.length;
    return done(queue.some((d) => d.attention) ? "importBlocked" : "downloading");
  }

  if (!facts.title.monitored || nothingMonitoredToSearch(input.service, facts)) return done("unmonitored");
  if (!facts.released) return done("notReleased");

  if (!input.failures?.ok) return done("unreachable", { errorKind: kindOf(input.failures) });
  const recent = input.failures.value
    .filter((e) => e.kind === "failed")
    .filter((e) => {
      const ms = arrDateMs(e.date);
      return ms !== null && ms >= input.sinceMs;
    })
    .sort((a, b) => (arrDateMs(b.date) ?? 0) - (arrDateMs(a.date) ?? 0) || b.id - a.id);
  if (recent.length > 0) {
    const last = recent[0];
    base.failures = {
      count: countFailedDownloads(recent),
      lastAt: last.date,
      message: scrubMessage(last.message, [last.sourceTitle, last.downloadId, last.downloadClient, last.indexer, last.droppedPath, last.importedPath]),
    };
    // The newest failure is the reason only when no import came at or after it.
    if (!input.imports?.ok) return done("unreachable", { errorKind: kindOf(input.imports) });
    const importMs = input.imports.value
      .filter((e) => e.kind === "imported")
      .map((e) => arrDateMs(e.date))
      .filter((ms): ms is number => ms !== null);
    const lastImportMs = importMs.length > 0 ? Math.max(...importMs) : null;
    const lastFailureMs = arrDateMs(last.date);
    if (lastImportMs === null || (lastFailureMs !== null && lastFailureMs > lastImportMs)) return done("downloadFailed");
  }

  if (input.service === "sonarr" && (facts.episodes?.withFile ?? 0) > 0) return done("incomplete");
  return done("waiting");
}
