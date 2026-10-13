// Admin → Arr System: the pure half. Radarr's and Sonarr's scheduled tasks and
// recent commands, their indexers and download clients, and their storage
// (root folders, unmapped folders, disks) — projected to what the page shows.
// Zero I/O; the data half is arr-system-data.ts.
//
// An indexer or download client resource carries its whole configuration in
// `fields`: API keys, passkeys, usernames, passwords, cookie strings. NONE of
// it is projected — only the named top-level fields below reach the browser —
// and every message an indexer, client or the arr wrote is masked
// (safeMessage) because a failure can quote the request URL it tried
// (guardrail 5e).
import {
  bool,
  bytesOrNull,
  idsOf,
  int,
  isoOrNull,
  nonNegInt,
  posInt,
  protocolOf,
  safeMessage,
  text,
  textOrNull,
  type Protocol,
} from "./arr-parse";
import { parseTimeSpan } from "./arr-queue";
import type { ArrService } from "./arr-instances";

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Raw) : null);

// ── scheduled tasks ──────────────────────────────────────────────────────────

export interface ArrTask {
  /** The command name the arr runs (RssSync, Backup, …) — what "Run now" sends. */
  taskName: string;
  /** The arr's own label ("RSS Sync"). */
  name: string;
  intervalMinutes: number | null;
  lastExecution: string | null;
  lastStartTime: string | null;
  lastDurationSeconds: number | null;
  nextExecution: string | null;
}

const TASK_NAME = /^[A-Za-z][A-Za-z0-9]{1,79}$/;

/** /api/v3/system/task → the instance's scheduled tasks, by name. */
export function projectTasks(raw: unknown): ArrTask[] {
  if (!Array.isArray(raw)) return [];
  const out: ArrTask[] = [];
  for (const x of raw) {
    const r = obj(x);
    const taskName = typeof r?.taskName === "string" ? r.taskName : "";
    if (!r || !TASK_NAME.test(taskName) || out.some((t) => t.taskName === taskName)) continue;
    out.push({
      taskName,
      name: text(r.name, 100) || taskName,
      intervalMinutes: nonNegInt(r.interval),
      lastExecution: isoOrNull(r.lastExecution),
      lastStartTime: isoOrNull(r.lastStartTime),
      lastDurationSeconds: parseTimeSpan(r.lastDuration),
      nextExecution: isoOrNull(r.nextExecution),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function isTaskName(v: unknown): v is string {
  return typeof v === "string" && TASK_NAME.test(v);
}

/**
 * A scheduled task the page confirms before running: the update check
 * (Radarr's ApplicationCheckUpdate, Sonarr's ApplicationUpdateCheck) INSTALLS
 * an available update and restarts the arr when run by hand, and a library
 * refresh (RefreshMovie / RefreshSeries) re-reads every title's metadata and
 * rescans every file. Anchored on the name: Sonarr's UpdateSceneMapping is a
 * harmless list download, not an update.
 */
export type TaskRisk = "update" | "refreshLibrary";

export function taskRisk(taskName: string): TaskRisk | null {
  if (/^Application\w*Update/.test(taskName)) return "update";
  if (/^Refresh(Movie|Series)$/.test(taskName)) return "refreshLibrary";
  return null;
}

// ── commands ─────────────────────────────────────────────────────────────────

export type CommandStatus = "queued" | "started" | "completed" | "failed" | "aborted" | "cancelled" | "orphaned" | "unknown";
const COMMAND_STATUSES: readonly CommandStatus[] = ["queued", "started", "completed", "failed", "aborted", "cancelled", "orphaned"];

export interface ArrCommandRow {
  id: number;
  /** The arr's label ("Rss Sync"), else its command name. */
  name: string;
  /** The command's own name ("RssSync") — what a scheduled task's taskName matches. */
  commandName: string;
  status: CommandStatus;
  trigger: "manual" | "scheduled" | "other";
  queued: string | null;
  started: string | null;
  ended: string | null;
  durationSeconds: number | null;
  /** The arr's progress or result line, credentials masked. */
  message: string | null;
}

/** How many FINISHED commands are listed; queued and running ones are always kept. */
export const MAX_COMMANDS = 30;
/** A runaway bound on queued + running commands, far past anything an instance queues. */
export const MAX_ACTIVE_COMMANDS = 500;

const isActive = (c: ArrCommandRow) => c.status === "queued" || c.status === "started";

/**
 * /api/v3/command → the instance's commands: queued and running first, then
 * finished ones, each newest first. Only the finished ones are capped at
 * `limit`: a library-wide search started an hour ago sorts behind every
 * command finished since, and cutting it off the list would re-enable its
 * task's Run button while it still runs. The command BODY is never projected
 * (it can hold paths, ids and import details).
 */
export function projectCommands(raw: unknown, limit = MAX_COMMANDS): ArrCommandRow[] {
  if (!Array.isArray(raw)) return [];
  const out: ArrCommandRow[] = [];
  for (const x of raw) {
    const r = obj(x);
    const id = posInt(r?.id);
    if (!r || id === null) continue;
    const status = typeof r.status === "string" ? r.status.toLowerCase() : "";
    const trigger = typeof r.trigger === "string" ? r.trigger.toLowerCase() : "";
    // CommandResource: `name` is the command ("RssSync"), `commandName` its label ("Rss Sync").
    const commandName = text(r.name, 100) || text(r.commandName, 100);
    out.push({
      id,
      name: text(r.commandName, 100) || commandName,
      commandName,
      status: (COMMAND_STATUSES as readonly string[]).includes(status) ? (status as CommandStatus) : "unknown",
      trigger: trigger === "manual" ? "manual" : trigger === "scheduled" ? "scheduled" : "other",
      queued: isoOrNull(r.queued),
      started: isoOrNull(r.started),
      ended: isoOrNull(r.ended),
      durationSeconds: parseTimeSpan(r.duration),
      message: safeMessage(r.message, 300),
    });
  }
  const at = (c: ArrCommandRow) => c.started ?? c.queued ?? "";
  out.sort((a, b) => at(b).localeCompare(at(a)) || b.id - a.id);
  // A caller asking for more (cancelCommand's lookup) gets every active one too.
  return [...out.filter(isActive).slice(0, Math.max(MAX_ACTIVE_COMMANDS, limit)), ...out.filter((c) => !isActive(c)).slice(0, limit)];
}

// ── the page's library-wide searches ─────────────────────────────────────────

/**
 * The two library-wide actions beyond the scheduled tasks: search every
 * monitored missing title, or every monitored title below its profile's
 * cutoff (an upgrade search). Both hit every indexer for every such title.
 */
export type ArrBulkAction = "searchMissing" | "searchCutoff";

export function isBulkAction(v: unknown): v is ArrBulkAction {
  return v === "searchMissing" || v === "searchCutoff";
}

/**
 * The arr command for a bulk action.
 *   Sonarr — its commands take `monitored`; sent explicitly, so the scope
 *     never rests on a default.
 *   Radarr — MissingMoviesSearch / CutoffUnmetMoviesSearch have NO such field
 *     (Radarr searches monitored movies only, hard-coded), so none is sent.
 *     Every command started through the API is a MANUAL search, and a manual
 *     search ignores Minimum Availability: announced and in-cinema movies are
 *     searched too. The page says so before it starts one.
 */
export function bulkActionCommand(service: ArrService, action: ArrBulkAction): Record<string, unknown> {
  if (service === "radarr") {
    return action === "searchMissing" ? { name: "MissingMoviesSearch" } : { name: "CutoffUnmetMoviesSearch" };
  }
  return action === "searchMissing"
    ? { name: "MissingEpisodeSearch", monitored: true }
    : { name: "CutoffUnmetEpisodeSearch", monitored: true };
}

// ── indexers and download clients ────────────────────────────────────────────

export type ProviderKind = "indexer" | "downloadClient";

export function parseProviderKind(v: unknown): ProviderKind | null {
  return v === "indexer" || v === "downloadClient" ? v : null;
}

export const PROVIDER_PATH: Record<ProviderKind, string> = { indexer: "/api/v3/indexer", downloadClient: "/api/v3/downloadclient" };

// Which indexers are failing is NOT read here: neither Radarr nor Sonarr has an
// /api/v3/indexerstatus endpoint. The arr's own IndexerStatusCheck /
// IndexerLongTermStatusCheck say it, in the health panel above the page.
export interface ArrIndexer {
  id: number;
  name: string;
  /** "Newznab", "Torznab", … */
  implementation: string | null;
  protocol: Protocol;
  priority: number | null;
  enableRss: boolean;
  enableAutomaticSearch: boolean;
  enableInteractiveSearch: boolean;
  /**
   * Whether the indexer can do RSS / search at all (the arr's own
   * `supportsRss` / `supportsSearch` — a Torrent RSS Feed cannot search). Its
   * edit dialog disables a use it doesn't support; the arr itself saves the
   * flag anyway and nothing ever uses it. Null when the arr didn't say.
   */
  supportsRss: boolean | null;
  supportsSearch: boolean | null;
  tags: number[];
  /**
   * Synced from Prowlarr, which names the indexers it pushes "<name> (Prowlarr)".
   * Read from the name alone — never `fields`. Prowlarr's next full sync turns
   * a change made here back.
   */
  managedByProwlarr: boolean;
}

const PROWLARR_SUFFIX = /\(Prowlarr\)\s*$/;

export interface ArrDownloadClient {
  id: number;
  name: string;
  /** "qBittorrent", "SABnzbd", … */
  implementation: string | null;
  protocol: Protocol;
  priority: number | null;
  enable: boolean;
  removeCompletedDownloads: boolean | null;
  removeFailedDownloads: boolean | null;
  tags: number[];
}

/** /api/v3/indexer → the indexers, by priority then name. Never `fields`. */
export function projectIndexers(raw: unknown): ArrIndexer[] {
  if (!Array.isArray(raw)) return [];
  const out: ArrIndexer[] = [];
  for (const x of raw) {
    const r = obj(x);
    const id = posInt(r?.id);
    if (!r || id === null) continue;
    const name = text(r.name, 200);
    out.push({
      id,
      name: name || `#${id}`,
      implementation: textOrNull(r.implementationName, 100) ?? textOrNull(r.implementation, 100),
      protocol: protocolOf(r.protocol),
      priority: int(r.priority),
      enableRss: bool(r.enableRss),
      enableAutomaticSearch: bool(r.enableAutomaticSearch),
      enableInteractiveSearch: bool(r.enableInteractiveSearch),
      supportsRss: typeof r.supportsRss === "boolean" ? r.supportsRss : null,
      supportsSearch: typeof r.supportsSearch === "boolean" ? r.supportsSearch : null,
      tags: idsOf(r.tags, 100),
      managedByProwlarr: PROWLARR_SUFFIX.test(name),
    });
  }
  return out.sort((a, b) => (a.priority ?? 25) - (b.priority ?? 25) || a.name.localeCompare(b.name));
}

/** /api/v3/downloadclient → the download clients, by priority then name. Never `fields`. */
export function projectDownloadClients(raw: unknown): ArrDownloadClient[] {
  if (!Array.isArray(raw)) return [];
  const out: ArrDownloadClient[] = [];
  for (const x of raw) {
    const r = obj(x);
    const id = posInt(r?.id);
    if (!r || id === null) continue;
    out.push({
      id,
      name: text(r.name, 200) || `#${id}`,
      implementation: textOrNull(r.implementationName, 100) ?? textOrNull(r.implementation, 100),
      protocol: protocolOf(r.protocol),
      priority: int(r.priority),
      enable: bool(r.enable),
      removeCompletedDownloads: typeof r.removeCompletedDownloads === "boolean" ? r.removeCompletedDownloads : null,
      removeFailedDownloads: typeof r.removeFailedDownloads === "boolean" ? r.removeFailedDownloads : null,
      tags: idsOf(r.tags, 100),
    });
  }
  return out.sort((a, b) => (a.priority ?? 1) - (b.priority ?? 1) || a.name.localeCompare(b.name));
}

/** What an admin can switch on a provider. An indexer's three uses are separate, as in the arr. */
export interface ProviderEnableChange {
  enable?: boolean;
  enableRss?: boolean;
  enableAutomaticSearch?: boolean;
  enableInteractiveSearch?: boolean;
}

/** The change a request body asks for, or null when malformed or empty. Indexers take the three, clients `enable`. */
export function parseProviderEnableChange(kind: ProviderKind, body: Record<string, unknown>): ProviderEnableChange | null {
  const allowed = kind === "indexer" ? ["enableRss", "enableAutomaticSearch", "enableInteractiveSearch"] : ["enable"];
  const forbidden = kind === "indexer" ? ["enable"] : ["enableRss", "enableAutomaticSearch", "enableInteractiveSearch"];
  if (forbidden.some((k) => body[k] !== undefined)) return null;
  const change: ProviderEnableChange = {};
  for (const k of allowed) {
    const v = body[k];
    if (v === undefined) continue;
    if (typeof v !== "boolean") return null;
    (change as Record<string, boolean>)[k] = v;
  }
  return Object.keys(change).length > 0 ? change : null;
}

/**
 * The provider resource the arr sent, with only the switched flags changed —
 * PUT back to the arr as-is. The secrets in `fields` travel arr → server → arr
 * and never further; the browser only ever names the id and the flags.
 */
export function withProviderEnabled(raw: unknown, change: ProviderEnableChange): Raw {
  const r = obj(raw);
  if (!r) throw new Error("not a provider resource");
  return { ...r, ...change };
}

/**
 * The use a change switches ON that the indexer reports it can't do
 * (`supportsRss` / `supportsSearch` false on the fresh read), or null. A
 * download client, or an arr that doesn't say, never refuses. Switching an
 * unsupported use OFF is always allowed.
 */
export function unsupportedIndexerUse(raw: unknown, change: ProviderEnableChange): "rss" | "search" | null {
  const r = obj(raw);
  if (!r) return null;
  if (change.enableRss === true && r.supportsRss === false) return "rss";
  if ((change.enableAutomaticSearch === true || change.enableInteractiveSearch === true) && r.supportsSearch === false) return "search";
  return null;
}

/**
 * Did the arr's own copy, read back after a save we stopped waiting for, take
 * the change? Every switched flag must read as asked.
 */
export function providerChangeApplied(raw: unknown, change: ProviderEnableChange): boolean {
  const r = obj(raw);
  if (!r) return false;
  return Object.entries(change).every(([k, v]) => r[k] === v);
}

export interface ProviderTestResult {
  id: number;
  /** It works: no failure, or only warnings. */
  ok: boolean;
  /** It works, but the arr warned — every failure it reported is a warning. */
  warning: boolean;
  /** The arr's validation failures, credentials masked. */
  messages: string[];
  /**
   * Test All only: the arr reported failures, none of them is a known error,
   * and at least one doesn't say whether it is only a warning — what every
   * System.Text.Json arr sends (see warningFlag). `ok` and `warning` are false;
   * the page shows it neutrally and points at the row's own Test, whose answer
   * does carry the flag. Present only when true.
   */
  uncertain?: true;
}

/** An arr's validation failures: masked messages, and whether every one is only a warning. */
export interface ValidationFailures {
  /** Deduplicated, at most five. */
  messages: string[];
  /**
   * True when there is at least one failure and EVERY one is known to be a
   * warning — judged over the whole list, messageless and unreadable entries
   * included (an unreadable one is an error), so a dropped message can never
   * turn an error into "warnings only".
   */
  warningsOnly: boolean;
  /** No failure is a known error, but at least one carries no warning flag and was read as "unknown". */
  uncertain: boolean;
}

// Which failures are warnings, as read from the arrs' own source (2026-10-13:
// Radarr v3.2.2, v4.7.5, v5.28, develop; Sonarr v3, v4.0.20, v5.0, develop):
//   • The arr decides on NzbDroneValidationFailure.IsWarning alone —
//     NzbDroneValidationResult splits Errors/Warnings on it, taking it from an
//     `.AsWarning()` rule's CustomState for a plain FluentValidation failure.
//   • A /test or save 400 writes `validationException.Errors` as `object`
//     (STJson.ToJson; Radarr v3's STJson.Serialize casts to object), so by its
//     RUNTIME type, List<NzbDroneValidationFailure>, and every failure of the
//     provider's test carries `isWarning` (Sonarr v3: Newtonsoft, runtime types
//     throughout). A
//     failure without it is a resource validator's plain ValidationFailure,
//     which the arr refuses on outright — an error.
//   • Test All's ProviderTestAllResult.ValidationFailures is DECLARED
//     List<ValidationFailure>, and System.Text.Json writes a list element by its
//     declared type: on every STJ arr (Radarr v3 and later, Sonarr v4 and later,
//     /api/v3 and Sonarr's /api/v5 alike) an entry is only {propertyName,
//     errorMessage, severity}, and a warning's entry is shaped exactly like an
//     error's. Only Sonarr v3 (Newtonsoft) writes `isWarning` there.
//   • `severity` is always "error" — FluentValidation's default; neither arr
//     ever sets it — so it is never evidence of an error, and is read after
//     everything else, only as positive evidence. `customState` (what the arr
//     derives IsWarning from) never carries a warning the arr didn't also flag
//     `isWarning` — Test All's settings failures are the errors-only list — and
//     is read after it.
/** true / false: the failure says; null: it carries no warning flag at all. */
function warningFlag(r: Raw): boolean | null {
  if (typeof r.isWarning === "boolean") return r.isWarning;
  const state = obj(r.customState);
  if (typeof state?.isWarning === "boolean") return state.isWarning;
  if ((typeof r.severity === "string" && r.severity.toLowerCase() === "warning") || r.severity === 1) return true;
  return null;
}

/**
 * `unflagged` is what a failure with no warning flag counts as: "error" for a
 * /test or save 400 (there every warning is flagged — see warningFlag),
 * "unknown" for Test All, where a System.Text.Json arr flags nothing.
 */
export function projectFailures(v: unknown, unflagged: "error" | "unknown" = "error"): ValidationFailures {
  const list = Array.isArray(v) ? v : [];
  const messages: string[] = [];
  let errors = 0;
  let unknown = 0;
  for (const x of list) {
    const r = obj(x);
    const flag = r ? warningFlag(r) : false;
    if (flag === false || (flag === null && unflagged === "error")) errors++;
    else if (flag === null) unknown++;
    const m = safeMessage(r?.errorMessage ?? r?.message, 300);
    if (m && !messages.includes(m) && messages.length < 5) messages.push(m);
  }
  return { messages, warningsOnly: list.length > 0 && errors === 0 && unknown === 0, uncertain: errors === 0 && unknown > 0 };
}

/** A test outcome from the arr's verdict and its failures. */
export function testResultOf(id: number, isValid: boolean, failures: ValidationFailures): ProviderTestResult {
  return {
    id,
    ok: isValid || failures.warningsOnly,
    warning: !isValid && failures.warningsOnly,
    messages: failures.messages,
    ...(!isValid && failures.uncertain ? { uncertain: true as const } : {}),
  };
}

/**
 * /api/v3/{indexer,downloadclient}/testall → one result per provider. The arr
 * marks a provider with only warnings invalid; here it is working, with
 * warnings — when the arr says so (Sonarr v3). An STJ arr's entries carry no
 * flag, so a provider with no known error is `uncertain`, never "failed".
 */
export function projectTestAll(raw: unknown): ProviderTestResult[] {
  if (!Array.isArray(raw)) return [];
  const out: ProviderTestResult[] = [];
  for (const x of raw) {
    const r = obj(x);
    const id = posInt(r?.id);
    if (!r || id === null) continue;
    out.push(testResultOf(id, r.isValid === true, projectFailures(r.validationFailures, "unknown")));
  }
  return out;
}

/** The validation failures in a 400 body from a test or a save (a list of {errorMessage, isWarning}), masked. */
export function validationFailuresFromBody(body: string): ValidationFailures {
  try {
    const parsed = JSON.parse(body) as unknown;
    return projectFailures(Array.isArray(parsed) ? parsed : [parsed]);
  } catch {
    const m = safeMessage(body, 300);
    return { messages: m ? [m] : [], warningsOnly: false, uncertain: false };
  }
}

export function validationMessagesFromBody(body: string): string[] {
  return validationFailuresFromBody(body).messages;
}

// ── background jobs, as the page polls them ──────────────────────────────────

/**
 * How many `?job=` polls in a row may fail in TRANSPORT before the page stops
 * waiting — and then it shows the change as still running, never as failed.
 */
export const JOB_MAX_FAILED_POLLS = 5;

/**
 * A `?job=` poll that failed on the way, not the job's own answer: the fetch
 * threw (status 0), or a proxy answered 502–504 with no JSON body. The job
 * keeps running on the server, and may land and be audited, so this is never
 * the change's failure. Every answer of the job itself is JSON — arrFailure's
 * 502/504, a save's 504 { timedOut }, a 409 — and stays terminal; so does the
 * 500 a thrown job answers with.
 */
export function isTransientJobPollFailure(status: number, body: unknown): boolean {
  return status === 0 || (status >= 502 && status <= 504 && (body === null || body === undefined));
}

// ── tags ─────────────────────────────────────────────────────────────────────

export interface ArrTag { id: number; label: string }

/** /api/v3/tag → id and label, to name the tags indexers and clients carry. */
export function projectTags(raw: unknown): ArrTag[] {
  if (!Array.isArray(raw)) return [];
  const out: ArrTag[] = [];
  for (const x of raw) {
    const r = obj(x);
    const id = posInt(r?.id);
    const label = textOrNull(r?.label, 100);
    if (id === null || label === null || out.some((t) => t.id === id)) continue;
    out.push({ id, label });
    if (out.length >= 1_000) break;
  }
  return out;
}

// ── storage ──────────────────────────────────────────────────────────────────

export interface UnmappedFolder { name: string; path: string }

export interface ArrRootFolder {
  id: number;
  path: string;
  accessible: boolean;
  freeSpace: number | null;
  /** The size of the disk the folder sits on (see projectRootFolders), null when no disk holds it. */
  totalSpace: number | null;
  /** Folders in the root the arr has no title for (bounded; `unmappedCount` is the true count). */
  unmappedFolders: UnmappedFolder[];
  unmappedCount: number;
}

export interface ArrDisk { path: string; label: string | null; freeSpace: number | null; totalSpace: number | null }

export const MAX_UNMAPPED = 500;

// A path compared as a path: either separator, no trailing one, and a Windows
// drive path case-insensitively ("C:\Movies" and "c:/movies/" are one place).
function comparablePath(p: string): string {
  let s = p.replace(/\\/g, "/");
  while (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
  return /^[A-Za-z]:/.test(s) ? s.toLowerCase() : s;
}

/**
 * The disk a folder sits on: the /diskspace entry whose path is the LONGEST
 * whole-segment prefix of the folder's ("/mnt/media" holds "/mnt/media/movies",
 * never "/mnt/media2/movies"; "/" holds everything when nothing nearer does).
 */
export function diskFor(path: string, disks: readonly ArrDisk[]): ArrDisk | null {
  const p = comparablePath(path);
  let best: ArrDisk | null = null;
  let bestLen = -1;
  for (const d of disks) {
    const dp = comparablePath(d.path);
    const holds = p === dp || p.startsWith(dp.endsWith("/") ? dp : `${dp}/`);
    if (holds && dp.length > bestLen) {
      best = d;
      bestLen = dp.length;
    }
  }
  return best;
}

/**
 * A root folder's free space and its disk's agree within the larger of these —
 * the two are read moments apart, and an import in flight moves both.
 */
export const DISK_MATCH_TOLERANCE_BYTES = 1000 ** 3;
export const DISK_MATCH_TOLERANCE_RATIO = 0.01;

/**
 * The /diskspace entry a root folder is on, or null when none can be believed.
 * diskFor takes the longest disk path holding the folder's — and "/" holds
 * every path, so a root folder on a mount /diskspace doesn't list (mergerfs,
 * Unraid's shfs, an rclone mount) is matched to the container root and judged
 * against ITS size. The match is believed only when the root folder's own free
 * space (Radarr/Sonarr measure the folder itself) agrees with that disk's. A
 * root folder or disk that reports none can't be checked: a nearer disk keeps
 * the match, but the catch-all "/" never does (unless the folder IS "/") — it
 * is the one match this exists to refuse, and with nothing to compare it can't
 * be believed (an arr whose statfs on a slow network mount timed out reports
 * the folder accessible with no free space).
 * Shared by the Storage tab (projectRootFolders) and the monitor (arr-watch,
 * guardrail 7c), so the two never disagree about which disk a folder is on.
 */
export function rootDisk(root: Pick<ArrRootFolder, "path" | "freeSpace">, disks: readonly ArrDisk[]): ArrDisk | null {
  const disk = diskFor(root.path, disks);
  if (!disk) return null;
  if (root.freeSpace === null || disk.freeSpace === null) {
    return comparablePath(disk.path) === "/" && comparablePath(root.path) !== "/" ? null : disk;
  }
  const tolerance = Math.max(DISK_MATCH_TOLERANCE_BYTES, disk.freeSpace * DISK_MATCH_TOLERANCE_RATIO);
  return Math.abs(root.freeSpace - disk.freeSpace) <= tolerance ? disk : null;
}

/**
 * /api/v3/rootfolder → the root folders. Neither arr's RootFolderResource has a
 * total size, so it comes from the disk the folder sits on (`disks`, the same
 * instance's /api/v3/diskspace) — without one the page could show free space
 * but never how full the disk is. Only a disk rootDisk believes lends its
 * size: a folder on a mount /diskspace doesn't list would otherwise show the
 * container root's ("18 TB free of 100 GB"), so its total stays unknown.
 */
export function projectRootFolders(raw: unknown, disks: readonly ArrDisk[] = []): ArrRootFolder[] {
  if (!Array.isArray(raw)) return [];
  const out: ArrRootFolder[] = [];
  for (const x of raw) {
    const r = obj(x);
    const id = posInt(r?.id);
    const path = textOrNull(r?.path, 1_000);
    if (!r || id === null || path === null) continue;
    const unmapped: UnmappedFolder[] = [];
    const list = Array.isArray(r.unmappedFolders) ? r.unmappedFolders : [];
    for (const u of list) {
      const f = obj(u);
      const name = textOrNull(f?.name, 300);
      if (!f || name === null) continue;
      unmapped.push({ name, path: text(f.path, 1_000) });
      if (unmapped.length >= MAX_UNMAPPED) break;
    }
    const freeSpace = bytesOrNull(r.freeSpace);
    out.push({
      id,
      path,
      accessible: r.accessible !== false,
      freeSpace,
      totalSpace: bytesOrNull(r.totalSpace) ?? rootDisk({ path, freeSpace }, disks)?.totalSpace ?? null,
      unmappedFolders: unmapped.sort((a, b) => a.name.localeCompare(b.name)),
      unmappedCount: list.length,
    });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export function projectDisks(raw: unknown): ArrDisk[] {
  if (!Array.isArray(raw)) return [];
  const out: ArrDisk[] = [];
  for (const x of raw) {
    const r = obj(x);
    const path = textOrNull(r?.path, 1_000);
    if (!r || path === null || out.some((d) => d.path === path)) continue;
    out.push({ path, label: textOrNull(r.label, 200), freeSpace: bytesOrNull(r.freeSpace), totalSpace: bytesOrNull(r.totalSpace) });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

// ── polling ──────────────────────────────────────────────────────────────────

export type LoadKind = "poll" | "manual";

/**
 * Which load of a polled admin report runs, and which may write state — shared
 * by the Arr System tabs and the Download Queue. Pure; no I/O.
 *
 * A POLL tick is skipped while a load is in flight. A dark instance holds its
 * read for the whole request timeout, longer than the poll interval, and a
 * tick that superseded it would discard it — every load was discarded by the
 * next, the report never arrived and the spinner (and the disabled Reload)
 * never cleared. A MANUAL load — Reload, or the re-read after an action —
 * always starts and supersedes whatever is in flight. Only the newest load may
 * write state.
 */
export interface LoadGate {
  /** The new load's id, or null when this poll tick is skipped. */
  begin(kind: LoadKind): number | null;
  /** True when `id` is still the newest load: it may write state, and polls may start again. */
  settle(id: number): boolean;
}

export function createLoadGate(): LoadGate {
  let seq = 0;
  let inFlight: number | null = null;
  return {
    begin(kind) {
      if (kind === "poll" && inFlight !== null) return null;
      inFlight = ++seq;
      return inFlight;
    },
    settle(id) {
      if (id !== inFlight) return false;
      inFlight = null;
      return true;
    },
  };
}
