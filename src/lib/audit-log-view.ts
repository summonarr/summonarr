import type { AuditAction } from "@/generated/prisma";
import type { Translator } from "./i18n/translate";

// Pure helpers for the admin audit-log viewer, shared by the client table
// (components/admin/audit-log-table.tsx) and the server page. No React, no
// prisma — so the summaries can be unit-tested by importing this module.

// The saved Table/Timeline choice. A cookie rather than localStorage alone, so
// the page can render the first paint in the saved view instead of flashing
// the table before a mount effect switches it.
export type AuditViewMode = "table" | "timeline";
export const AUDIT_VIEW_COOKIE = "summonarr-audit-view";

export function parseAuditViewMode(value: string | null | undefined): AuditViewMode | null {
  return value === "table" || value === "timeline" ? value : null;
}

// A row's details as an object, or null — for a missing value, unparseable
// JSON, or JSON that is not a plain object (a scalar or an array from a
// restored backup or a hand edit; `"before" in parsed` throws on a scalar).
export function parseDetails(details: string | null): Record<string, unknown> | null {
  if (!details) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(details);
  } catch {
    return null;
  }
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

// One summary line from optional fragments: falsy ones are dropped, an empty
// result is null.
function joinParts(parts: readonly unknown[], sep: string): string | null {
  return parts.filter(Boolean).join(sep) || null;
}

// Plural lookups need a real number; a malformed payload counts as 0.
const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

type Details = Record<string, unknown>;
type Formatter = (d: Details, t: Translator) => string | null;

const note = (d: Details, t: Translator) => d.adminNote && t("adminManage.audit.summary.note", { note: String(d.adminNote).slice(0, 80) });
const media = (d: Details) => d.mediaType && `(${String(d.mediaType).toLowerCase()})`;
const reason = (d: Details) => d.reason && `— ${String(d.reason).slice(0, 80)}`;
const via = (d: Details, t: Translator) => d.provider && t("adminManage.audit.summary.via", { provider: String(d.provider) });
// Newer user-admin rows name the account by id (+ display name when it has
// one) and never carry an email; older rows still have targetUser/targetEmail
// until the retention scrub removes them.
const targetUserOf = (d: Details) => d.targetUser ?? d.targetUserId;
// Since 2026-10-20 the requester is `requesterId` (+ `requestedBy` only when
// the account has a display name); older rows carry `requestedBy` alone, a
// name or an email until a scrub removes it.
const requesterOf = (d: Details) => d.requestedBy ?? d.requesterId;
const quotedTitle = (d: Details) => d.title && `"${d.title}"`;
const email = (d: Details) => d.targetEmail && `(${d.targetEmail})`;
const none: Formatter = () => null;

function requestModeration(d: Details, t: Translator): string | null {
  // The batch route logs a bulk approve or non-permanent decline under these
  // same actions, but with a {batch, count, ids} shape instead of a single
  // title. (A permanent bulk decline has its own action.)
  if (d.batch) {
    return joinParts([
      t("adminManage.audit.summary.batch", { count: num(d.count) }),
      d.permanent && t("adminManage.audit.summary.permanent"),
      note(d, t),
    ], " · ");
  }
  const requester = requesterOf(d);
  return joinParts([
    quotedTitle(d),
    media(d),
    d.year && `[${d.year}]`,
    requester && t("adminManage.audit.summary.requestedBy", { user: String(requester) }),
  ], " ");
}

function userChange(d: Details, t: Translator): string | null {
  const targetUser = targetUserOf(d);
  return joinParts([targetUser && t("adminManage.audit.summary.user", { user: String(targetUser) }), email(d)], " ");
}

function settingsChange(d: Details, t: Translator): string | null {
  // Checked, not cast: a restored backup or a hand edit can carry `keys` as a
  // string, and a throw here takes the whole audit page down.
  if (Array.isArray(d.keys) && d.keys.length > 0) {
    return t("adminManage.audit.summary.changed", { keys: d.keys.map(String).join(", ") });
  }
  // Instance-manager saves ({service, instances[]}) and the PII scrub
  // ({scrubbed}) log under SETTINGS_CHANGE with their own shapes.
  if (d.service && Array.isArray(d.instances)) {
    const removed = Array.isArray(d.removed) && d.removed.length > 0
      ? ` · ${t("adminManage.audit.summary.removed", { list: d.removed.join(", ") })}`
      : "";
    return `${d.service}: ${t("adminManage.audit.summary.instances", { count: d.instances.length })}${removed}`;
  }
  if (d.scrubbed != null) return t("adminManage.audit.summary.scrubbedRows", { count: num(d.scrubbed) });
  // TRaSH sync also logs under SETTINGS_CHANGE, with its own shape
  // ({refreshed[], applied{count,failures}, errors[], durationMs}). Summarize
  // it in one line instead of dumping the whole `refreshed` array as JSON.
  if (Array.isArray(d.refreshed) || d.applied != null) {
    const applied = d.applied !== null && typeof d.applied === "object" ? (d.applied as Details) : undefined;
    const failures = num(applied?.failures);
    const recreated = num(applied?.recreated);
    const errors = Array.isArray(d.errors) ? d.errors.length : 0;
    return joinParts([
      Array.isArray(d.refreshed) && t("adminManage.audit.summary.refreshedServices", { count: d.refreshed.length }),
      applied?.count != null && t("adminManage.audit.summary.appliedSpecs", { count: num(applied.count) }),
      recreated > 0 && t("adminManage.audit.summary.recreated", { count: recreated }),
      failures > 0 && t("adminManage.audit.summary.failed", { count: failures }),
      errors > 0 && t("adminManage.audit.summary.errors", { count: errors }),
    ], " · ");
  }
  return null;
}

function exportSummary(d: Details, t: Translator): string | null {
  return joinParts([
    d.format && t("adminManage.audit.summary.format", { format: String(d.format).toUpperCase() }),
    d.rowCount != null && num(d.rowCount) > 0 && t("adminManage.audit.summary.rows", { count: num(d.rowCount) }),
    d.truncated === true && t("adminManage.audit.summary.truncated"),
    d.status && `(${d.status})`,
  ], " · ");
}

function sessionTerminate(d: Details): string | null {
  const title = d.mediaTitle ?? d.title;
  const who = d.accountName ?? d.userName;
  return joinParts([title && `"${title}"`, who && `· ${who}`, reason(d)], " ");
}

function serverUserLink(d: Details, t: Translator): string | null {
  const mode = d.mode === "auto"
    ? t("adminManage.audit.summary.linkAuto")
    : d.mode === "manual-unlink"
      ? t("adminManage.audit.summary.linkManualUnlink")
      : t("adminManage.audit.summary.linkManual");
  return joinParts([d.serverUser && `${d.serverUser}`, d.source && `(${d.source})`, `— ${mode}`], " ");
}

// One formatter per action. `satisfies` makes a new AuditAction without an
// entry a compile error; an action with nothing to summarize says so (none).
const SUMMARIES = {
  REQUEST_COMMENT: (d, t) => {
    const requester = requesterOf(d);
    return joinParts([
      quotedTitle(d),
      media(d),
      d.fromAdmin ? t("adminManage.audit.summary.commentByManager") : t("adminManage.audit.summary.commentByRequester"),
      requester && t("adminManage.audit.summary.requestedBy", { user: String(requester) }),
    ], " ");
  },
  REQUEST_APPROVE: requestModeration,
  REQUEST_DECLINE: requestModeration,
  REQUEST_DELETE: requestModeration,
  BATCH_REQUEST_DECLINE: (d, t) => joinParts([
    t("adminManage.audit.summary.batchDeclined", { count: num(d.count) }),
    d.permanent && t("adminManage.audit.summary.permanent"),
    note(d, t),
  ], " · "),
  REQUEST_ON_BEHALF: (d, t) => {
    const targetUser = targetUserOf(d);
    return joinParts([
      d.created != null && t("adminManage.audit.summary.requestsCreated", { count: num(d.created) }),
      targetUser && t("adminManage.audit.summary.forUser", { user: String(targetUser) }),
    ], " ");
  },
  USER_ROLE_CHANGE: userChange,
  USER_PERMISSIONS_CHANGE: userChange,
  USER_CREATE: (d, t) => {
    const targetUser = targetUserOf(d);
    return joinParts([
      targetUser && t("adminManage.audit.summary.created", { user: String(targetUser) }),
      email(d),
      d.role && `· ${d.role}`,
    ], " ");
  },
  USER_DELETE: (d, t) => joinParts([
    d.targetUser && t("adminManage.audit.summary.deletedUser", { user: String(d.targetUser) }),
    email(d),
  ], " "),
  USER_DEACTIVATE: (d, t) => {
    const targetUser = targetUserOf(d);
    return joinParts([
      targetUser ? t("adminManage.audit.summary.disabled", { user: String(targetUser) }) : null,
      email(d),
      d.kind === "self-delete" && t("adminManage.audit.summary.closedByUser"),
    ], " ");
  },
  USER_REACTIVATE: (d, t) => {
    const targetUser = targetUserOf(d);
    return joinParts([targetUser && t("adminManage.audit.summary.reenabled", { user: String(targetUser) }), email(d)], " ");
  },
  USER_PURGE: (d, t) => {
    const kept = d.historyPreserved !== null && typeof d.historyPreserved === "object" ? (d.historyPreserved as Details) : undefined;
    return joinParts([
      d.targetUser && t("adminManage.audit.summary.purged", { user: String(d.targetUser) }),
      kept && t("adminManage.audit.summary.kept", {
        requests: num(kept.mediaRequests),
        issues: num(kept.issues),
        votes: num(kept.deletionVotes),
      }),
    ], " · ");
  },
  SETTINGS_CHANGE: settingsChange,
  MAINTENANCE_TOGGLE: settingsChange,
  ISSUE_STATUS_CHANGE: (d) => (d.title ? `"${d.title}"` : null),
  ISSUE_CLAIM: (d) => (d.title ? `"${d.title}"` : null),
  ISSUE_UNCLAIM: (d) => (d.title ? `"${d.title}"` : null),
  ISSUE_DELETE: (d) => joinParts([quotedTitle(d), media(d)], " "),
  CONTENT_REPORT: (d) => joinParts([d.contentType && d.contentId && `${d.contentType} #${d.contentId}`, reason(d)], " "),
  VOTE_DISMISS_ALL: (d, t) => joinParts([
    d.dismissedCount != null && t("adminManage.audit.summary.dismissedVotes", { count: num(d.dismissedCount) }),
    d.tmdbId && `tmdb:${d.tmdbId}`,
    media(d),
  ], " "),
  FIX_MATCH: (d, t) => joinParts([
    d.source && `${d.source}:`,
    d.fromTmdbId && d.toTmdbId && `tmdb ${d.fromTmdbId} → ${d.toTmdbId}`,
    media(d),
    d.serverInstance && t("adminManage.audit.summary.onInstance", { instance: String(d.serverInstance) }),
  ], " "),
  SERVER_USERS_BULK: (d, t) => joinParts([
    d.downloadsEnabled != null &&
      (d.downloadsEnabled
        ? t("adminManage.audit.summary.downloadsEnabled")
        : t("adminManage.audit.summary.downloadsDisabled")),
    d.targetCount != null && t("adminManage.audit.summary.forUsers", { count: num(d.targetCount) }),
    d.pushed != null && t("adminManage.audit.summary.pushed", { count: num(d.pushed) }),
  ], " "),
  SERVER_USER_LINK: serverUserLink,
  PLEX_SESSION_TERMINATE: sessionTerminate,
  JELLYFIN_SESSION_TERMINATE: sessionTerminate,
  LIBRARY_SYNC: (d, t) => joinParts([
    d.movies != null && t("adminManage.audit.summary.movies", { count: num(d.movies) }),
    d.tv != null && t("adminManage.audit.summary.tv", { count: num(d.tv) }),
    d.marked != null && t("adminManage.audit.summary.markedAvailable", { count: num(d.marked) }),
    d.full === true && t("adminManage.audit.summary.fullResync"),
    d.durationMs != null && t("adminManage.audit.summary.inSeconds", { seconds: Math.round(num(d.durationMs) / 1000) }),
  ], " · "),
  CACHE_WARM: (d, t) => joinParts([
    d.warmed != null && t("adminManage.audit.summary.warmed", { count: num(d.warmed) }),
    d.fetched != null && t("adminManage.audit.summary.fetched", { count: num(d.fetched) }),
    d.skipped != null && t("adminManage.audit.summary.skipped", { count: num(d.skipped) }),
    d.trigger && `(${d.trigger})`,
  ], " · "),
  RATINGS_CACHE_CLEAR: (d, t) => joinParts([
    d.cleared != null && t("adminManage.audit.summary.clearedEntries", { count: num(d.cleared) }),
    d.source && `(${d.source})`,
  ], " "),
  PLAY_HISTORY_BACKFILL: (d, t) => joinParts([
    d.updated != null && t("adminManage.audit.summary.clampedRows", { count: num(d.updated) }),
    d.watchedFlippedToFalse != null && t("adminManage.audit.summary.watchedFlipped", { count: num(d.watchedFlippedToFalse) }),
  ], " · "),
  PLAY_HISTORY_DELETE: (d) => joinParts([quotedTitle(d), d.source && `(${d.source})`], " "),
  PLAY_HISTORY_EXPORT: exportSummary,
  AUDIT_LOG_EXPORT: exportSummary,
  BLACKLIST_CHANGE: (d, t) => joinParts([
    d.op === "remove" ? t("adminManage.audit.summary.unblocked") : t("adminManage.audit.summary.blocked"),
    quotedTitle(d),
    reason(d),
  ], " "),
  LIBRARY_CLEANUP_DELETE: (d, t) => joinParts([
    quotedTitle(d),
    Array.isArray(d.deleted) && d.deleted.length > 0 && t("adminManage.audit.summary.removedFrom", { list: d.deleted.join(", ") }),
    Array.isArray(d.failed) && d.failed.length > 0 && t("adminManage.audit.summary.failedOn", { list: d.failed.join(", ") }),
    d.blacklisted === true && `· ${t("adminManage.audit.summary.blacklisted")}`,
  ], " "),
  LIBRARY_CLEANUP_PROTECT: (d, t) => joinParts([
    d.op === "remove" ? t("adminManage.audit.summary.unprotected") : t("adminManage.audit.summary.protected"),
    quotedTitle(d),
    reason(d),
  ], " "),
  BACKUP_EXPORT: (d, t) => joinParts([
    d.format && t("adminManage.audit.summary.format", { format: String(d.format).toUpperCase() }),
    d.totalRows != null && t("adminManage.audit.summary.rows", { count: num(d.totalRows) }),
    d.userCount != null && t("adminManage.audit.summary.usersAndRequests", { users: num(d.userCount), requests: num(d.requestCount) }),
    d.includeSensitive && t("adminManage.audit.summary.inclSensitive"),
    d.status && `(${d.status})`,
  ], " · "),
  BACKUP_IMPORT: (d, t) => joinParts([
    d.format && t("adminManage.audit.summary.format", { format: String(d.format).toUpperCase() }),
    d.outcome && `(${d.outcome})`,
  ], " · "),
  AUTH_LOGIN: (d, t) => joinParts([d.email && `${d.email}`, d.role && `(${d.role})`, via(d, t)], " "),
  AUTH_LOGIN_FAILED: (d, t) => joinParts([
    d.reason && t("adminManage.audit.summary.reason", { reason: String(d.reason).replace(/_/g, " ") }),
    via(d, t),
  ], " · "),
  AUTH_LOGOUT: (d, t) => joinParts([d.email && `${d.email}`, via(d, t)], " "),
  // An admin's single-session revoke names the account AND the device (its
  // target is the account since 2026-10-20; older rows had `session:<sid>`).
  SESSION_REVOKE: (d, t) => {
    const targetUser = targetUserOf(d);
    return joinParts([
      targetUser && t("adminManage.audit.summary.user", { user: String(targetUser) }),
      d.deviceLabel && t("adminManage.audit.summary.device", { device: String(d.deviceLabel) }),
      d.revokedAll && t("adminManage.audit.summary.allSessions"),
      d.adminAction && t("adminManage.audit.summary.byAdmin"),
      d.revokedByOwner && t("adminManage.audit.summary.byOwner"),
    ], " · ");
  },
  MFA_CHANGE: (d, t) => joinParts([
    d.kind && String(d.kind).replace(/-/g, " "),
    d.name && `"${String(d.name)}"`,
    typeof d.otherSessionsRevoked === "number" && d.otherSessionsRevoked > 0 &&
      t("adminManage.audit.summary.otherSessionsSignedOut", { count: d.otherSessionsRevoked }),
  ], " · "),
  MFA_RESET: (d, t) => {
    const targetUser = targetUserOf(d);
    return targetUser ? t("adminManage.audit.summary.user", { user: String(targetUser) }) : null;
  },
  // The row's target and the details panel say everything these record.
  REQUEST_AUTO: none,
  ARR_QUEUE_REMOVE: none,
  ARR_RELEASE_GRAB: none,
  ARR_QUEUE_IMPORT: none,
  ARR_TITLE_EDIT: none,
  ARR_FILE_DELETE: none,
  ARR_FILE_RENAME: none,
  ARR_MARK_FAILED: none,
  ARR_BLOCKLIST_CHANGE: none,
  ARR_COMMAND: none,
  ARR_PROVIDER_CHANGE: none,
  ARR_TITLE_ADD: none,
  ARR_TITLE_DELETE: none,
  PUSH_BROADCAST: none,
} satisfies Record<AuditAction, Formatter>;

/**
 * One summary line for an audit row's details, or null. `action` is a string
 * (a row restored from an older backup may name an action this build lacks):
 * an unknown one summarizes to null.
 */
export function formatSummary(action: string, d: Record<string, unknown>, t: Translator): string | null {
  return Object.hasOwn(SUMMARIES, action) ? SUMMARIES[action as AuditAction](d, t) : null;
}

// Render one side of a before/after diff. Writers log either an object of
// changed fields or a bare scalar (a permissions bitfield string, a
// mediaServer enum, a numeric quota, a boolean flag, or null for "cleared"),
// so only a plain object is spread into `key: value` pairs; anything else is
// shown whole, labelled with the entry's `field` when it has one.
function formatDiffValue(v: unknown, t: Translator): string {
  if (v === null || v === undefined) return t("adminManage.audit.none");
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

export function formatDiffSide(value: unknown, field: unknown, t: Translator): string | null {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return null;
    return entries.map(([k, v]) => `${k}: ${formatDiffValue(v, t)}`).join(", ");
  }
  const text = formatDiffValue(value, t);
  return typeof field === "string" && field ? `${field}: ${text}` : text;
}
