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

export const MAX_COMMANDS = 30;

/**
 * /api/v3/command → the instance's recent commands, newest first. The command
 * BODY is never projected (it can hold paths, ids and import details).
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
  return out.sort((a, b) => at(b).localeCompare(at(a)) || b.id - a.id).slice(0, limit);
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

/** The arr command for a bulk action. `monitored: true` keeps Sonarr to monitored episodes (its default is ALL). */
export function bulkActionCommand(service: ArrService, action: ArrBulkAction): Record<string, unknown> {
  if (service === "radarr") {
    return action === "searchMissing"
      ? { name: "MissingMoviesSearch", monitored: true }
      : { name: "CutoffUnmetMoviesSearch", monitored: true };
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

export interface IndexerStatus {
  /** The arr has stopped using it until then, after repeated failures. */
  disabledTill: string | null;
  initialFailure: string | null;
  mostRecentFailure: string | null;
}

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
  tags: number[];
  status: IndexerStatus | null;
}

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

function statusMap(raw: unknown): Map<number, IndexerStatus> {
  const out = new Map<number, IndexerStatus>();
  if (!Array.isArray(raw)) return out;
  for (const x of raw) {
    const r = obj(x);
    const id = posInt(r?.indexerId ?? r?.providerId);
    if (!r || id === null) continue;
    out.set(id, {
      disabledTill: isoOrNull(r.disabledTill),
      initialFailure: isoOrNull(r.initialFailure),
      mostRecentFailure: isoOrNull(r.mostRecentFailure),
    });
  }
  return out;
}

/** /api/v3/indexer (+ /api/v3/indexerstatus) → the indexers, by priority then name. Never `fields`. */
export function projectIndexers(raw: unknown, statusRaw: unknown = []): ArrIndexer[] {
  if (!Array.isArray(raw)) return [];
  const statuses = statusMap(statusRaw);
  const out: ArrIndexer[] = [];
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
      enableRss: bool(r.enableRss),
      enableAutomaticSearch: bool(r.enableAutomaticSearch),
      enableInteractiveSearch: bool(r.enableInteractiveSearch),
      tags: idsOf(r.tags, 100),
      status: statuses.get(id) ?? null,
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

export interface ProviderTestResult {
  id: number;
  ok: boolean;
  /** The arr's validation failures, credentials masked. */
  messages: string[];
}

function failureMessages(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    const r = obj(x);
    const m = safeMessage(r?.errorMessage ?? r?.message, 300);
    if (m && !out.includes(m)) out.push(m);
    if (out.length >= 5) break;
  }
  return out;
}

/** /api/v3/{indexer,downloadclient}/testall → one result per provider. */
export function projectTestAll(raw: unknown): ProviderTestResult[] {
  if (!Array.isArray(raw)) return [];
  const out: ProviderTestResult[] = [];
  for (const x of raw) {
    const r = obj(x);
    const id = posInt(r?.id);
    if (!r || id === null) continue;
    out.push({ id, ok: r.isValid === true, messages: failureMessages(r.validationFailures) });
  }
  return out;
}

/** The validation failures in a 400 body from a test or a save (a list of {errorMessage}), masked. */
export function validationMessagesFromBody(body: string): string[] {
  try {
    const parsed = JSON.parse(body) as unknown;
    return failureMessages(Array.isArray(parsed) ? parsed : [parsed]);
  } catch {
    const m = safeMessage(body, 300);
    return m ? [m] : [];
  }
}

// ── storage ──────────────────────────────────────────────────────────────────

export interface UnmappedFolder { name: string; path: string }

export interface ArrRootFolder {
  id: number;
  path: string;
  accessible: boolean;
  freeSpace: number | null;
  totalSpace: number | null;
  /** Folders in the root the arr has no title for (bounded; `unmappedCount` is the true count). */
  unmappedFolders: UnmappedFolder[];
  unmappedCount: number;
}

export interface ArrDisk { path: string; label: string | null; freeSpace: number | null; totalSpace: number | null }

export const MAX_UNMAPPED = 500;

export function projectRootFolders(raw: unknown): ArrRootFolder[] {
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
    out.push({
      id,
      path,
      accessible: r.accessible !== false,
      freeSpace: bytesOrNull(r.freeSpace),
      totalSpace: bytesOrNull(r.totalSpace),
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
