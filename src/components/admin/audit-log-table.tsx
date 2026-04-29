"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { List, Activity, Download, X, ChevronDown, ChevronRight, Monitor, Globe, Shield, Bot } from "lucide-react";
import { useHasMounted } from "@/hooks/use-has-mounted";

interface AuditRow {
  id: string;
  createdAt: string;
  userName: string;
  action: string;
  target: string;
  details: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  provider: string | null;
}

const ACTION_LABELS: Record<string, { label: string; color: string; icon: string }> = {
  REQUEST_APPROVE:    { label: "Request Approved",    color: "bg-green-900/50 text-green-400",   icon: "approve" },
  REQUEST_DECLINE:    { label: "Request Declined",    color: "bg-red-900/50 text-red-400",       icon: "decline" },
  REQUEST_DELETE:     { label: "Request Deleted",     color: "bg-red-900/50 text-red-400",       icon: "delete" },
  USER_ROLE_CHANGE:   { label: "Role Changed",        color: "bg-blue-900/50 text-blue-400",     icon: "role" },
  USER_DELETE:        { label: "User Deleted",        color: "bg-red-900/50 text-red-400",       icon: "delete" },
  SETTINGS_CHANGE:    { label: "Settings Changed",    color: "bg-yellow-900/50 text-yellow-400", icon: "settings" },
  LIBRARY_SYNC:       { label: "Library Synced",      color: "bg-purple-900/50 text-purple-400", icon: "sync" },
  ISSUE_STATUS_CHANGE:{ label: "Issue Updated",       color: "bg-orange-900/50 text-orange-400", icon: "issue" },
  ISSUE_CLAIM:        { label: "Issue Claimed",       color: "bg-orange-900/50 text-orange-400", icon: "issue" },
  ISSUE_UNCLAIM:      { label: "Issue Unclaimed",     color: "bg-zinc-700/50 text-zinc-400",     icon: "issue" },
  ISSUE_DELETE:       { label: "Issue Deleted",       color: "bg-red-900/50 text-red-400",       icon: "delete" },
  MAINTENANCE_TOGGLE: { label: "Maintenance Toggle",  color: "bg-yellow-900/50 text-yellow-400", icon: "maintenance" },
  BACKUP_EXPORT:      { label: "Backup Exported",     color: "bg-indigo-900/50 text-indigo-400", icon: "export" },
  BACKUP_IMPORT:      { label: "Backup Imported",     color: "bg-indigo-900/50 text-indigo-400", icon: "import" },
  AUTH_LOGIN:         { label: "Login",               color: "bg-emerald-900/50 text-emerald-400", icon: "login" },
  AUTH_LOGIN_FAILED:  { label: "Login Failed",        color: "bg-red-900/50 text-red-400",       icon: "login_failed" },
  AUTH_LOGOUT:        { label: "Logout",              color: "bg-zinc-700/50 text-zinc-400",     icon: "logout" },
  SESSION_REVOKE:     { label: "Session Revoked",     color: "bg-orange-900/50 text-orange-400", icon: "revoke" },
  CACHE_WARM:         { label: "Cache Warmed",        color: "bg-purple-900/50 text-purple-400", icon: "sync" },
  RATINGS_CACHE_CLEAR:{ label: "Ratings Cache Cleared", color: "bg-purple-900/50 text-purple-400", icon: "sync" },
  PLAY_HISTORY_BACKFILL: { label: "Play History Backfilled", color: "bg-purple-900/50 text-purple-400", icon: "sync" },
};

const ALL_ACTIONS = Object.keys(ACTION_LABELS);

type AuditGroup = "auth" | "admin" | "system";

const ACTION_GROUP: Record<string, AuditGroup> = {
  AUTH_LOGIN: "auth",
  AUTH_LOGIN_FAILED: "auth",
  AUTH_LOGOUT: "auth",
  SESSION_REVOKE: "auth",
  REQUEST_APPROVE: "admin",
  REQUEST_DECLINE: "admin",
  REQUEST_DELETE: "admin",
  USER_ROLE_CHANGE: "admin",
  USER_DELETE: "admin",
  SETTINGS_CHANGE: "admin",
  MAINTENANCE_TOGGLE: "admin",
  BACKUP_EXPORT: "admin",
  BACKUP_IMPORT: "admin",
  ISSUE_STATUS_CHANGE: "admin",
  ISSUE_CLAIM: "admin",
  ISSUE_UNCLAIM: "admin",
  ISSUE_DELETE: "admin",
  LIBRARY_SYNC: "system",
  CACHE_WARM: "system",
  RATINGS_CACHE_CLEAR: "system",
  PLAY_HISTORY_BACKFILL: "system",
};

const GROUP_OPTIONS: { value: AuditGroup | ""; label: string }[] = [
  { value: "", label: "All" },
  { value: "auth", label: "Auth" },
  { value: "admin", label: "Admin" },
  { value: "system", label: "System" },
];

const DOT_COLORS: Record<string, string> = {
  REQUEST_APPROVE:    "bg-green-500",
  REQUEST_DECLINE:    "bg-red-500",
  REQUEST_DELETE:     "bg-red-500",
  USER_ROLE_CHANGE:   "bg-blue-500",
  USER_DELETE:        "bg-red-500",
  SETTINGS_CHANGE:    "bg-yellow-500",
  LIBRARY_SYNC:       "bg-purple-500",
  ISSUE_STATUS_CHANGE:"bg-orange-500",
  ISSUE_CLAIM:        "bg-orange-500",
  ISSUE_UNCLAIM:      "bg-zinc-500",
  ISSUE_DELETE:       "bg-red-500",
  MAINTENANCE_TOGGLE: "bg-yellow-500",
  BACKUP_EXPORT:      "bg-indigo-500",
  BACKUP_IMPORT:      "bg-indigo-500",
  AUTH_LOGIN:         "bg-emerald-500",
  AUTH_LOGIN_FAILED:  "bg-red-500",
  AUTH_LOGOUT:        "bg-zinc-500",
  SESSION_REVOKE:     "bg-orange-500",
  CACHE_WARM:         "bg-purple-500",
  RATINGS_CACHE_CLEAR:"bg-purple-500",
  PLAY_HISTORY_BACKFILL: "bg-purple-500",
};

function useAuditNav() {
  const router = useRouter();
  const searchParams = useSearchParams();
  return useCallback(function navigate(params: Record<string, string>) {
    const sp = new URLSearchParams(searchParams.toString());
    for (const [k, v] of Object.entries(params)) {
      if (v) sp.set(k, v);
      else sp.delete(k);
    }
    router.push(`/admin/audit-log?${sp.toString()}`);
  }, [router, searchParams]);
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

function formatDateGroup(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);

  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
}

function parseDetails(details: string | null): Record<string, unknown> | null {
  if (!details) return null;
  try {
    return JSON.parse(details);
  } catch {
    return null;
  }
}

function parseUserAgent(ua: string | null): string {
  if (!ua) return "Unknown";
  if (ua.includes("Firefox")) return "Firefox";
  if (ua.includes("Edg/")) return "Edge";
  if (ua.includes("Chrome")) return "Chrome";
  if (ua.includes("Safari")) return "Safari";
  if (ua.includes("curl")) return "curl";
  return ua.slice(0, 30) + (ua.length > 30 ? "..." : "");
}

function AuditLogFilters({
  currentAction,
  currentGroup,
  currentDateFrom,
  currentDateTo,
  currentUser,
  currentTarget,
  currentHideCron,
  viewMode,
  onViewModeChange,
}: {
  currentAction: string;
  currentGroup: string;
  currentDateFrom: string;
  currentDateTo: string;
  currentUser: string;
  currentTarget: string;
  currentHideCron: boolean;
  viewMode: "table" | "timeline";
  onViewModeChange: (mode: "table" | "timeline") => void;
}) {
  const navigate = useAuditNav();
  const [userInput, setUserInput] = useState(currentUser);
  const [targetInput, setTargetInput] = useState(currentTarget);
  const userTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const targetTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const hasFilters = currentAction || currentGroup || currentDateFrom || currentDateTo || currentUser || currentTarget || currentHideCron;

  // When a group is selected, scope the per-action pills to that group
  const visibleActions = currentGroup
    ? ALL_ACTIONS.filter((a) => ACTION_GROUP[a] === currentGroup)
    : ALL_ACTIONS;

  useEffect(() => {
    clearTimeout(userTimer.current);
    userTimer.current = setTimeout(() => {
      if (userInput !== currentUser) navigate({ user: userInput });
    }, 500);
    return () => clearTimeout(userTimer.current);
  }, [userInput, currentUser, navigate]);

  useEffect(() => {
    clearTimeout(targetTimer.current);
    targetTimer.current = setTimeout(() => {
      if (targetInput !== currentTarget) navigate({ target: targetInput });
    }, 500);
    return () => clearTimeout(targetTimer.current);
  }, [targetInput, currentTarget, navigate]);

  return (
    <div className="space-y-3">
      <div
        className="inline-flex"
        style={{
          padding: 2,
          background: "var(--ds-bg-2)",
          border: "1px solid var(--ds-border)",
          borderRadius: 8,
        }}
      >
        {GROUP_OPTIONS.map((g) => {
          const active = currentGroup === g.value;
          return (
            <button
              key={g.value || "all"}
              onClick={() => navigate({ group: g.value, action: "" })}
              className="ds-mono font-medium transition-colors"
              style={{
                padding: "5px 12px",
                fontSize: 11,
                letterSpacing: "0.04em",
                textTransform: "uppercase",
                borderRadius: 6,
                background: active ? "var(--ds-bg-3)" : "transparent",
                color: active ? "var(--ds-fg)" : "var(--ds-fg-subtle)",
                fontWeight: active ? 600 : 500,
              }}
            >
              {g.label}
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1.5">
          <button
            onClick={() => navigate({ action: "" })}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
              !currentAction ? "bg-indigo-600 text-white" : "bg-zinc-800 text-zinc-400 hover:text-white"
            }`}
          >
            All
          </button>
          {visibleActions.map((a) => (
            <button
              key={a}
              onClick={() => navigate({ action: a })}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                currentAction === a ? "bg-indigo-600 text-white" : "bg-zinc-800 text-zinc-400 hover:text-white"
              }`}
            >
              {ACTION_LABELS[a].label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => navigate({ hideCron: currentHideCron ? "" : "1" })}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
              currentHideCron
                ? "bg-indigo-600 text-white"
                : "bg-zinc-800 text-zinc-400 hover:text-white"
            }`}
            title={currentHideCron ? "Showing only real users — click to include cron jobs" : "Hide system cron job entries"}
          >
            <Bot size={14} /> {currentHideCron ? "Cron hidden" : "Hide cron"}
          </button>

          <div className="flex rounded-md border border-zinc-700 overflow-hidden">
            <button
              onClick={() => onViewModeChange("table")}
              className={`p-1.5 transition-colors ${viewMode === "table" ? "bg-indigo-600 text-white" : "bg-zinc-800 text-zinc-400 hover:text-white"}`}
              title="Table view"
            >
              <List size={16} />
            </button>
            <button
              onClick={() => onViewModeChange("timeline")}
              className={`p-1.5 transition-colors ${viewMode === "timeline" ? "bg-indigo-600 text-white" : "bg-zinc-800 text-zinc-400 hover:text-white"}`}
              title="Timeline view"
            >
              <Activity size={16} />
            </button>
          </div>

          <ExportButton
            currentAction={currentAction}
            currentDateFrom={currentDateFrom}
            currentDateTo={currentDateTo}
            currentUser={currentUser}
            currentTarget={currentTarget}
            currentHideCron={currentHideCron}
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1.5">
          <label className="text-xs text-zinc-500">From</label>
          <input
            type="date"
            value={currentDateFrom}
            onChange={(e) => navigate({ dateFrom: e.target.value })}
            className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-xs text-zinc-300 focus:outline-none focus:ring-1 focus:ring-indigo-500 [color-scheme:dark]"
          />
        </div>
        <div className="flex items-center gap-1.5">
          <label className="text-xs text-zinc-500">To</label>
          <input
            type="date"
            value={currentDateTo}
            onChange={(e) => navigate({ dateTo: e.target.value })}
            className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-xs text-zinc-300 focus:outline-none focus:ring-1 focus:ring-indigo-500 [color-scheme:dark]"
          />
        </div>
        <Input
          placeholder="Search by user..."
          value={userInput}
          onChange={(e) => setUserInput(e.target.value)}
          className="w-40 !h-[30px] !text-xs bg-zinc-800 border-zinc-700"
        />
        <Input
          placeholder="Search by target..."
          value={targetInput}
          onChange={(e) => setTargetInput(e.target.value)}
          className="w-40 !h-[30px] !text-xs bg-zinc-800 border-zinc-700"
        />
        {hasFilters && (
          <button
            onClick={() => {
              setUserInput("");
              setTargetInput("");
              navigate({ action: "", group: "", dateFrom: "", dateTo: "", user: "", target: "", hideCron: "" });
            }}
            className="flex items-center gap-1 px-2 py-1.5 rounded-md text-xs text-zinc-400 hover:text-white bg-zinc-800 hover:bg-zinc-700 transition-colors"
          >
            <X size={12} /> Clear
          </button>
        )}
      </div>
    </div>
  );
}

function ExportButton({
  currentAction,
  currentDateFrom,
  currentDateTo,
  currentUser,
  currentTarget,
  currentHideCron,
}: {
  currentAction: string;
  currentDateFrom: string;
  currentDateTo: string;
  currentUser: string;
  currentTarget: string;
  currentHideCron: boolean;
}) {
  const [open, setOpen] = useState(false);

  function exportAs(format: "csv" | "json") {
    const params = new URLSearchParams();
    params.set("format", format);
    if (currentAction) params.set("action", currentAction);
    if (currentDateFrom) params.set("dateFrom", currentDateFrom);
    if (currentDateTo) params.set("dateTo", currentDateTo);
    if (currentUser) params.set("user", currentUser);
    if (currentTarget) params.set("target", currentTarget);
    if (currentHideCron) params.set("hideCron", "1");
    window.open(`/api/admin/audit-log/export?${params.toString()}`, "_blank");
    setOpen(false);
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-zinc-800 text-zinc-400 hover:text-white transition-colors"
      >
        <Download size={14} /> Export
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-1 z-20 bg-zinc-800 border border-zinc-700 rounded-md shadow-lg overflow-hidden">
            <button onClick={() => exportAs("csv")} className="block w-full text-left px-4 py-2 text-xs text-zinc-300 hover:bg-zinc-700">
              Export as CSV
            </button>
            <button onClick={() => exportAs("json")} className="block w-full text-left px-4 py-2 text-xs text-zinc-300 hover:bg-zinc-700">
              Export as JSON
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function formatSummary(action: string, d: Record<string, unknown>): string | null {
  switch (action) {
    case "REQUEST_APPROVE":
    case "REQUEST_DECLINE":
    case "REQUEST_DELETE":
      return [
        d.title && `"${d.title}"`,
        d.mediaType && `(${String(d.mediaType).toLowerCase()})`,
        d.year && `[${d.year}]`,
        d.requestedBy && `requested by ${d.requestedBy}`,
      ].filter(Boolean).join(" ") || null;
    case "USER_ROLE_CHANGE":
      return [
        d.targetUser && `User: ${d.targetUser}`,
        d.targetEmail && `(${d.targetEmail})`,
      ].filter(Boolean).join(" ") || null;
    case "USER_DELETE":
      return [
        d.targetUser && `Deleted user: ${d.targetUser}`,
        d.targetEmail && `(${d.targetEmail})`,
      ].filter(Boolean).join(" ") || null;
    case "SETTINGS_CHANGE":
    case "MAINTENANCE_TOGGLE": {
      const keys = d.keys as string[] | undefined;
      if (!keys?.length) return null;
      return `Changed: ${keys.join(", ")}`;
    }
    case "ISSUE_STATUS_CHANGE":
      return d.title ? `"${d.title}"` : null;
    case "BACKUP_EXPORT":
      return [
        d.format && `Format: ${String(d.format).toUpperCase()}`,
        d.totalRows != null && `${d.totalRows} rows`,
        d.userCount != null && `${d.userCount} users, ${d.requestCount ?? 0} requests`,
        d.includeSensitive && "incl. sensitive",
      ].filter(Boolean).join(" · ") || null;
    case "BACKUP_IMPORT":
      return [
        d.format && `Format: ${String(d.format).toUpperCase()}`,
      ].filter(Boolean).join(" · ") || null;
    case "AUTH_LOGIN":
      return [
        d.email && `${d.email}`,
        d.role && `(${d.role})`,
        d.provider && `via ${d.provider}`,
      ].filter(Boolean).join(" ") || null;
    case "AUTH_LOGIN_FAILED":
      return [
        d.reason && `Reason: ${String(d.reason).replace(/_/g, " ")}`,
        d.provider && `via ${d.provider}`,
      ].filter(Boolean).join(" · ") || null;
    case "AUTH_LOGOUT":
      return [
        d.email && `${d.email}`,
        d.provider && `via ${d.provider}`,
      ].filter(Boolean).join(" ") || null;
    case "SESSION_REVOKE":
      return [
        d.targetUser ? `User: ${String(d.targetUser)}` : d.deviceLabel && `Device: ${String(d.deviceLabel)}`,
        d.revokedAll && "All sessions",
        d.adminAction && "by admin",
        d.revokedByOwner && "by owner",
      ].filter(Boolean).join(" · ") || null;
    default:
      return null;
  }
}

function DetailSection({ details, action, expanded }: { details: string | null; action: string; expanded?: boolean }) {
  const [isExpanded, setIsExpanded] = useState(expanded ?? false);
  const parsed = parseDetails(details);
  if (!parsed) return <span className="text-zinc-600 text-xs">—</span>;

  const before = parsed.before as Record<string, unknown> | undefined;
  const after = parsed.after as Record<string, unknown> | undefined;
  const hasDiff = before || after;

  const summary = formatSummary(action, parsed);

  return (
    <div className="text-xs">
      {hasDiff ? (
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="flex items-center gap-1 text-zinc-300 hover:text-zinc-100 transition-colors text-left"
        >
          {isExpanded ? <ChevronDown size={12} className="shrink-0" /> : <ChevronRight size={12} className="shrink-0" />}
          <span>{summary || "View changes"}</span>
        </button>
      ) : (
        <span className="text-zinc-400">{summary || Object.entries(parsed).map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`).join(", ")}</span>
      )}

      {isExpanded && hasDiff && (
        <div className="mt-2 pl-4 space-y-1.5 border-l-2 border-zinc-700/60">
          {before && Object.keys(before).length > 0 && (
            <div className="flex items-start gap-2">
              <span className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-red-900/40 text-red-400">BEFORE</span>
              <span className="text-red-400/70">{Object.entries(before).map(([k, v]) => `${k}: ${v}`).join(", ")}</span>
            </div>
          )}
          {after && Object.keys(after).length > 0 && (
            <div className="flex items-start gap-2">
              <span className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-green-900/40 text-green-400">AFTER</span>
              <span className="text-green-400/70">{Object.entries(after).map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`).join(", ")}</span>
            </div>
          )}
          {after && (action === "BACKUP_IMPORT") && (
            <div className="text-zinc-500 mt-1">
              {Object.entries(after).map(([k, v]) => (
                <span key={k} className="mr-3">{k}: <span className="text-zinc-400">{String(v)}</span></span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function AuditLogTable({ logs, mounted }: { logs: AuditRow[]; mounted: boolean }) {
  return (
    <Card className="bg-zinc-900 border-zinc-800 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-800 text-zinc-500 text-xs uppercase tracking-wider">
              <th className="text-left px-4 py-3 font-medium">Time</th>
              <th className="text-left px-4 py-3 font-medium">User</th>
              <th className="text-left px-4 py-3 font-medium">Action</th>
              <th className="text-left px-4 py-3 font-medium">Target</th>
              <th className="text-left px-4 py-3 font-medium">Details</th>
              <th className="text-left px-4 py-3 font-medium">Source</th>
            </tr>
          </thead>
          <tbody>
            {logs.map((log) => {
              const actionInfo = ACTION_LABELS[log.action] ?? { label: log.action, color: "bg-zinc-800 text-zinc-400" };
              return (
                <tr key={log.id} className="border-b border-zinc-800/50 hover:bg-zinc-800/30">
                  <td className="px-4 py-3 text-zinc-400 whitespace-nowrap text-xs" title={mounted ? new Date(log.createdAt).toLocaleString() : undefined}>
                    {mounted ? relativeTime(log.createdAt) : ""}
                  </td>
                  <td className="px-4 py-3 text-white text-sm">{log.userName}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${actionInfo.color}`}>
                      {actionInfo.label}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-zinc-300 max-w-[200px] truncate text-xs font-mono">{log.target}</td>
                  <td className="px-4 py-3 max-w-[300px]">
                    <DetailSection details={log.details} action={log.action} />
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2 text-xs text-zinc-500">
                      {log.ipAddress && (
                        <span className="flex items-center gap-1" title={`IP: ${log.ipAddress}`}>
                          <Globe size={11} /> {log.ipAddress}
                        </span>
                      )}
                      {log.provider && (
                        <span className="flex items-center gap-1" title={`Provider: ${log.provider}`}>
                          <Shield size={11} /> {log.provider}
                        </span>
                      )}
                      {log.userAgent && (
                        <span className="flex items-center gap-1" title={log.userAgent}>
                          <Monitor size={11} /> {parseUserAgent(log.userAgent)}
                        </span>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function AuditLogTimeline({ logs, mounted }: { logs: AuditRow[]; mounted: boolean }) {
  const groups: { date: string; logs: AuditRow[] }[] = [];
  let currentDate = "";

  for (const log of logs) {
    const dateStr = new Date(log.createdAt).toDateString();
    if (dateStr !== currentDate) {
      currentDate = dateStr;
      groups.push({ date: log.createdAt, logs: [] });
    }
    groups[groups.length - 1].logs.push(log);
  }

  return (
    <div className="space-y-6">
      {groups.map((group) => (
        <div key={group.date}>
          <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-3">
            {mounted ? formatDateGroup(group.date) : ""}
          </h3>
          <div className="relative pl-6">
            <div className="absolute left-[7px] top-2 bottom-2 w-px bg-zinc-800" />

            <div className="space-y-3">
              {group.logs.map((log) => {
                const actionInfo = ACTION_LABELS[log.action] ?? { label: log.action, color: "bg-zinc-800 text-zinc-400" };
                const dotColor = DOT_COLORS[log.action] ?? "bg-zinc-500";

                return (
                  <div key={log.id} className="relative">
                    <div className={`absolute -left-6 top-2 w-[14px] h-[14px] rounded-full border-2 border-zinc-900 ${dotColor}`} />

                    <Card className="bg-zinc-900 border-zinc-800 p-3">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-medium text-white">{log.userName}</span>
                          <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${actionInfo.color}`}>
                            {actionInfo.label}
                          </span>
                          <span className="text-xs text-zinc-500 font-mono">{log.target}</span>
                        </div>
                        <span className="text-xs text-zinc-600" title={mounted ? new Date(log.createdAt).toLocaleString() : undefined}>
                          {mounted ? relativeTime(log.createdAt) : ""}
                        </span>
                      </div>

                      <div className="mt-2">
                        <DetailSection details={log.details} action={log.action} />
                      </div>

                      {(log.ipAddress || log.provider || log.userAgent) && (
                        <div className="flex items-center gap-3 mt-2 text-[11px] text-zinc-600">
                          {log.ipAddress && (
                            <span className="flex items-center gap-1">
                              <Globe size={10} /> {log.ipAddress}
                            </span>
                          )}
                          {log.provider && (
                            <span className="flex items-center gap-1">
                              <Shield size={10} /> {log.provider}
                            </span>
                          )}
                          {log.userAgent && (
                            <span className="flex items-center gap-1">
                              <Monitor size={10} /> {parseUserAgent(log.userAgent)}
                            </span>
                          )}
                        </div>
                      )}
                    </Card>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export function AuditLogView({
  initialLogs,
  initialNextCursor,
  initialHasMore,
  currentAction,
  currentGroup,
  currentDateFrom,
  currentDateTo,
  currentUser,
  currentTarget,
  currentHideCron,
}: {
  initialLogs: AuditRow[];
  initialNextCursor: string | null;
  initialHasMore: boolean;
  currentAction: string;
  currentGroup: string;
  currentDateFrom: string;
  currentDateTo: string;
  currentUser: string;
  currentTarget: string;
  currentHideCron: boolean;
}) {
  const [logs, setLogs] = useState(initialLogs);
  const [nextCursor, setNextCursor] = useState(initialNextCursor);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [loading, setLoading] = useState(false);
  const [viewMode, setViewMode] = useState<"table" | "timeline">("table");
  const mounted = useHasMounted();

  useEffect(() => {
    const saved = localStorage.getItem("audit-log-view");
    if (saved === "timeline" || saved === "table") setViewMode(saved);
  }, []);

  useEffect(() => {
    setLogs(initialLogs);
    setNextCursor(initialNextCursor);
    setHasMore(initialHasMore);
  }, [initialLogs, initialNextCursor, initialHasMore]);

  function handleViewModeChange(mode: "table" | "timeline") {
    setViewMode(mode);
    localStorage.setItem("audit-log-view", mode);
  }

  async function loadMore() {
    if (!nextCursor || loading) return;
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set("cursor", nextCursor);
      if (currentAction) params.set("action", currentAction);
      if (currentGroup) params.set("group", currentGroup);
      if (currentDateFrom) params.set("dateFrom", currentDateFrom);
      if (currentDateTo) params.set("dateTo", currentDateTo);
      if (currentUser) params.set("user", currentUser);
      if (currentTarget) params.set("target", currentTarget);
      if (currentHideCron) params.set("hideCron", "1");

      const res = await fetch(`/api/admin/audit-log?${params.toString()}`);
      if (!res.ok) return;
      const data = await res.json();
      setLogs((prev) => [...prev, ...data.logs]);
      setNextCursor(data.nextCursor);
      setHasMore(data.hasMore);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <AuditLogFilters
        currentAction={currentAction}
        currentGroup={currentGroup}
        currentDateFrom={currentDateFrom}
        currentDateTo={currentDateTo}
        currentUser={currentUser}
        currentTarget={currentTarget}
        currentHideCron={currentHideCron}
        viewMode={viewMode}
        onViewModeChange={handleViewModeChange}
      />

      {logs.length === 0 ? (
        <Card className="bg-zinc-900 border-zinc-800">
          <div className="p-8 text-center text-zinc-500 text-sm">
            No audit log entries found.
          </div>
        </Card>
      ) : viewMode === "table" ? (
        <AuditLogTable logs={logs} mounted={mounted} />
      ) : (
        <AuditLogTimeline logs={logs} mounted={mounted} />
      )}

      {hasMore && (
        <div className="flex justify-center">
          <button
            onClick={loadMore}
            disabled={loading}
            className="px-4 py-2 rounded-md bg-zinc-800 text-zinc-300 hover:bg-zinc-700 text-sm disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? "Loading..." : "Load More"}
          </button>
        </div>
      )}

      {!hasMore && logs.length > 0 && (
        <p className="text-center text-xs text-zinc-600">{logs.length} entries loaded</p>
      )}
    </div>
  );
}
