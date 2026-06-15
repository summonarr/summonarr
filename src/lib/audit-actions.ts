import { AuditAction } from "@/generated/prisma";

// Runtime list of every AuditAction enum value. Derived from the Prisma client's
// runtime enum object so it stays in lock-step with prisma/schema.prisma — adding
// a new enum value automatically appears in filter dropdowns and (more importantly)
// in the WHERE clauses of /api/admin/audit-log + /api/admin/audit-log/export so an
// export filter for the new action can't silently fall back to the unfiltered set.
export const AUDIT_ACTIONS: AuditAction[] = Object.values(AuditAction);

export type AuditGroup = "auth" | "admin" | "system";

// Coarse grouping used by the admin audit-log filter dropdown. Typed as
// Record<AuditAction, AuditGroup> so TypeScript fails the build if a new enum
// value is added without a group assignment — the previous shape (`Record<string,
// AuditGroup>`) silently allowed drift.
export const ACTION_GROUP: Record<AuditAction, AuditGroup> = {
  AUTH_LOGIN: "auth",
  AUTH_LOGIN_FAILED: "auth",
  AUTH_LOGOUT: "auth",
  SESSION_REVOKE: "auth",
  REQUEST_APPROVE: "admin",
  REQUEST_DECLINE: "admin",
  REQUEST_DELETE: "admin",
  REQUEST_ON_BEHALF: "admin",
  BATCH_REQUEST_DECLINE: "admin",
  USER_CREATE: "admin",
  USER_ROLE_CHANGE: "admin",
  USER_PERMISSIONS_CHANGE: "admin",
  USER_DELETE: "admin",
  SETTINGS_CHANGE: "admin",
  MAINTENANCE_TOGGLE: "admin",
  BACKUP_EXPORT: "admin",
  BACKUP_IMPORT: "admin",
  ISSUE_STATUS_CHANGE: "admin",
  ISSUE_CLAIM: "admin",
  ISSUE_UNCLAIM: "admin",
  ISSUE_DELETE: "admin",
  VOTE_DISMISS_ALL: "admin",
  FIX_MATCH: "admin",
  AUDIT_LOG_EXPORT: "admin",
  SERVER_USERS_BULK: "admin",
  PLEX_SESSION_TERMINATE: "admin",
  JELLYFIN_SESSION_TERMINATE: "admin",
  LIBRARY_SYNC: "system",
  CACHE_WARM: "system",
  RATINGS_CACHE_CLEAR: "system",
  PLAY_HISTORY_BACKFILL: "system",
  PLAY_HISTORY_DELETE: "system",
};

export interface ActionLabel {
  label: string;
  color: string;
  icon: string;
}

// Display metadata for the admin audit-log table. Same typing discipline — adding
// an enum value without a label here is a compile error, so new actions can't ship
// without a corresponding UI badge.
export const ACTION_LABELS: Record<AuditAction, ActionLabel> = {
  REQUEST_APPROVE:       { label: "Request Approved",         color: "bg-green-900/50 text-green-400",         icon: "approve" },
  REQUEST_DECLINE:       { label: "Request Declined",         color: "bg-red-900/50 text-red-400",             icon: "decline" },
  REQUEST_DELETE:        { label: "Request Deleted",          color: "bg-red-900/50 text-red-400",             icon: "delete" },
  REQUEST_ON_BEHALF:     { label: "Request On Behalf",        color: "bg-blue-900/50 text-blue-400",           icon: "approve" },
  BATCH_REQUEST_DECLINE: { label: "Batch Decline (Permanent)", color: "bg-red-900/50 text-red-400",            icon: "decline" },
  USER_CREATE:           { label: "User Created",             color: "bg-green-900/50 text-green-400",         icon: "role" },
  USER_ROLE_CHANGE:      { label: "Role Changed",             color: "bg-blue-900/50 text-blue-400",           icon: "role" },
  USER_PERMISSIONS_CHANGE: { label: "Permissions Changed",    color: "bg-blue-900/50 text-blue-400",           icon: "role" },
  USER_DELETE:           { label: "User Deleted",              color: "bg-red-900/50 text-red-400",            icon: "delete" },
  SETTINGS_CHANGE:       { label: "Settings Changed",          color: "bg-yellow-900/50 text-yellow-400",      icon: "settings" },
  LIBRARY_SYNC:          { label: "Library Synced",            color: "bg-purple-900/50 text-purple-400",      icon: "sync" },
  ISSUE_STATUS_CHANGE:   { label: "Issue Updated",             color: "bg-orange-900/50 text-orange-400",      icon: "issue" },
  ISSUE_CLAIM:           { label: "Issue Claimed",             color: "bg-orange-900/50 text-orange-400",      icon: "issue" },
  ISSUE_UNCLAIM:         { label: "Issue Unclaimed",           color: "bg-zinc-700/50 text-zinc-400",          icon: "issue" },
  ISSUE_DELETE:          { label: "Issue Deleted",             color: "bg-red-900/50 text-red-400",            icon: "delete" },
  MAINTENANCE_TOGGLE:    { label: "Maintenance Toggle",        color: "bg-yellow-900/50 text-yellow-400",      icon: "maintenance" },
  BACKUP_EXPORT:         { label: "Backup Exported",           color: "bg-indigo-900/50 text-indigo-400",      icon: "export" },
  BACKUP_IMPORT:         { label: "Backup Imported",           color: "bg-indigo-900/50 text-indigo-400",      icon: "import" },
  AUDIT_LOG_EXPORT:      { label: "Audit Log Exported",        color: "bg-indigo-900/50 text-indigo-400",      icon: "export" },
  AUTH_LOGIN:            { label: "Login",                     color: "bg-emerald-900/50 text-emerald-400",    icon: "login" },
  AUTH_LOGIN_FAILED:     { label: "Login Failed",              color: "bg-red-900/50 text-red-400",            icon: "login_failed" },
  AUTH_LOGOUT:           { label: "Logout",                    color: "bg-zinc-700/50 text-zinc-400",          icon: "logout" },
  SESSION_REVOKE:        { label: "Session Revoked",           color: "bg-orange-900/50 text-orange-400",      icon: "revoke" },
  CACHE_WARM:            { label: "Cache Warmed",              color: "bg-purple-900/50 text-purple-400",      icon: "sync" },
  RATINGS_CACHE_CLEAR:   { label: "Ratings Cache Cleared",     color: "bg-purple-900/50 text-purple-400",      icon: "sync" },
  PLAY_HISTORY_BACKFILL: { label: "Play History Backfilled",   color: "bg-purple-900/50 text-purple-400",      icon: "sync" },
  PLAY_HISTORY_DELETE:   { label: "Play History Deleted",      color: "bg-red-900/50 text-red-400",            icon: "delete" },
  VOTE_DISMISS_ALL:      { label: "Votes Dismissed",           color: "bg-zinc-700/50 text-zinc-400",          icon: "approve" },
  FIX_MATCH:             { label: "Library Match Fixed",       color: "bg-blue-900/50 text-blue-400",          icon: "sync" },
  SERVER_USERS_BULK:     { label: "Bulk Media-Server Action",  color: "bg-blue-900/50 text-blue-400",          icon: "role" },
  PLEX_SESSION_TERMINATE: { label: "Plex Session Terminated",  color: "bg-red-900/50 text-red-400",            icon: "delete" },
  JELLYFIN_SESSION_TERMINATE: { label: "Jellyfin Session Terminated", color: "bg-red-900/50 text-red-400",      icon: "delete" },
};
