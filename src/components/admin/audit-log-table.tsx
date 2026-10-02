"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { List, Activity, Download, X, ChevronDown, ChevronRight, Monitor, Globe, Shield, Bot } from "@/components/icons";
import { useHasMounted } from "@/hooks/use-has-mounted";
import { formatRelativeTimeLocalized } from "@/lib/relative-time";
import { ACTION_LABELS, ACTION_GROUP, type AuditGroup } from "@/lib/audit-actions";
import type { AuditAction } from "@/generated/prisma";
import { withBasePath } from "@/lib/base-path";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import type { Translator } from "@/lib/i18n/translate";

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

// ACTION_LABELS and ACTION_GROUP come from @/lib/audit-actions so every screen
// shares one list. Both are keyed by the AuditAction type, so adding an action
// to the schema forces a label and group to be added too.
const ALL_ACTIONS = Object.keys(ACTION_LABELS);

const GROUP_OPTIONS: { value: AuditGroup | ""; labelKey: string }[] = [
  { value: "", labelKey: "adminManage.audit.group.all" },
  { value: "auth", labelKey: "adminManage.audit.group.auth" },
  { value: "admin", labelKey: "adminManage.audit.group.admin" },
  { value: "system", labelKey: "adminManage.audit.group.system" },
];

// Human label for an action badge. The enum code itself is never translated;
// an unknown code (a newer server) falls back to the code.
function actionLabel(action: string, t: Translator): string {
  return action in ACTION_LABELS ? t(`adminManage.audit.action.${action}`) : action;
}

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

// Falls back to an absolute date past 7 days — audit rows are read long after
// the fact, where "43d ago" is less useful than the date itself.
function relativeTime(iso: string, locale: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff >= 7 * 86_400_000) return new Date(iso).toLocaleDateString(locale);
  return formatRelativeTimeLocalized(iso, locale);
}

function formatDateGroup(iso: string, t: Translator, locale: string): string {
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);

  if (date.toDateString() === today.toDateString()) return t("adminManage.audit.today");
  if (date.toDateString() === yesterday.toDateString()) return t("adminManage.audit.yesterday");
  return date.toLocaleDateString(locale, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
}

function parseDetails(details: string | null): Record<string, unknown> | null {
  if (!details) return null;
  try {
    return JSON.parse(details);
  } catch {
    return null;
  }
}

function parseUserAgent(ua: string | null, t: Translator): string {
  if (!ua) return t("adminManage.audit.unknown");
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
  const t = useT();
  const navigate = useAuditNav();
  const [userInput, setUserInput] = useState(currentUser);
  const [targetInput, setTargetInput] = useState(currentTarget);
  const userTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const targetTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // The search value the URL is expected to hold because of us — see the sync
  // effect below.
  const userUrlRef = useRef(currentUser);
  const targetUrlRef = useRef(currentTarget);

  const hasFilters = currentAction || currentGroup || currentDateFrom || currentDateTo || currentUser || currentTarget || currentHideCron;

  // When a group is selected, scope the per-action pills to that group
  const visibleActions = currentGroup
    ? ALL_ACTIONS.filter((a) => ACTION_GROUP[a as AuditAction] === currentGroup)
    : ALL_ACTIONS;

  // Copy the URL value into the text box when the user presses Back/Forward.
  // That kind of navigation doesn't remount this component, so without this the
  // box keeps the old text, the debounce below sees it differ from the URL, and
  // pushes the old filter again — making Back useless on this page.
  //
  // But ignore a URL change that our OWN debounce caused: the server response
  // arrives after the 500 ms debounce, so copying it back would wipe out
  // anything typed while it was loading.
  useEffect(() => {
    if (currentUser === userUrlRef.current) return;
    userUrlRef.current = currentUser;
    setUserInput(currentUser);
  }, [currentUser]);
  useEffect(() => {
    if (currentTarget === targetUrlRef.current) return;
    targetUrlRef.current = currentTarget;
    setTargetInput(currentTarget);
  }, [currentTarget]);

  useEffect(() => {
    clearTimeout(userTimer.current);
    userTimer.current = setTimeout(() => {
      if (userInput !== currentUser) {
        userUrlRef.current = userInput;
        navigate({ user: userInput });
      }
    }, 500);
    return () => clearTimeout(userTimer.current);
  }, [userInput, currentUser, navigate]);

  useEffect(() => {
    clearTimeout(targetTimer.current);
    targetTimer.current = setTimeout(() => {
      if (targetInput !== currentTarget) {
        targetUrlRef.current = targetInput;
        navigate({ target: targetInput });
      }
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
              {t(g.labelKey)}
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1.5">
          <button
            onClick={() => navigate({ action: "" })}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
              !currentAction ? "bg-indigo-600 text-[var(--ds-accent-fg)]" : "bg-zinc-800 text-zinc-400 hover:text-zinc-100"
            }`}
          >
            {t("adminManage.audit.group.all")}
          </button>
          {visibleActions.map((a) => (
            <button
              key={a}
              onClick={() => navigate({ action: a })}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                currentAction === a ? "bg-indigo-600 text-[var(--ds-accent-fg)]" : "bg-zinc-800 text-zinc-400 hover:text-zinc-100"
              }`}
            >
              {actionLabel(a, t)}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => navigate({ hideCron: currentHideCron ? "" : "1" })}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
              currentHideCron
                ? "bg-indigo-600 text-[var(--ds-accent-fg)]"
                : "bg-zinc-800 text-zinc-400 hover:text-zinc-100"
            }`}
            title={currentHideCron ? t("adminManage.audit.cronHiddenTitle") : t("adminManage.audit.hideCronTitle")}
          >
            <Bot size={14} /> {currentHideCron ? t("adminManage.audit.cronHidden") : t("adminManage.audit.hideCron")}
          </button>

          <div className="flex rounded-md border border-zinc-700 overflow-hidden">
            <button
              onClick={() => onViewModeChange("table")}
              className={`p-1.5 transition-colors ${viewMode === "table" ? "bg-indigo-600 text-[var(--ds-accent-fg)]" : "bg-zinc-800 text-zinc-400 hover:text-zinc-100"}`}
              title={t("adminManage.audit.tableView")}
              aria-label={t("adminManage.audit.tableView")}
            >
              <List size={16} />
            </button>
            <button
              onClick={() => onViewModeChange("timeline")}
              className={`p-1.5 transition-colors ${viewMode === "timeline" ? "bg-indigo-600 text-[var(--ds-accent-fg)]" : "bg-zinc-800 text-zinc-400 hover:text-zinc-100"}`}
              title={t("adminManage.audit.timelineView")}
              aria-label={t("adminManage.audit.timelineView")}
            >
              <Activity size={16} />
            </button>
          </div>

          <ExportButton
            currentAction={currentAction}
            currentGroup={currentGroup}
            currentDateFrom={currentDateFrom}
            currentDateTo={currentDateTo}
            currentUser={currentUser}
            currentTarget={currentTarget}
            currentHideCron={currentHideCron}
          />

          <ScrubPiiButton />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1.5">
          <label htmlFor="audit-date-from" className="text-xs text-zinc-500">{t("adminManage.audit.from")}</label>
          <input
            id="audit-date-from"
            type="date"
            value={currentDateFrom}
            onChange={(e) => navigate({ dateFrom: e.target.value })}
            className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-xs text-zinc-300 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:[color-scheme:dark]"
          />
        </div>
        <div className="flex items-center gap-1.5">
          <label htmlFor="audit-date-to" className="text-xs text-zinc-500">{t("adminManage.audit.to")}</label>
          <input
            id="audit-date-to"
            type="date"
            value={currentDateTo}
            onChange={(e) => navigate({ dateTo: e.target.value })}
            className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-xs text-zinc-300 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:[color-scheme:dark]"
          />
        </div>
        <Input
          placeholder={t("adminManage.audit.searchUserPlaceholder")}
          aria-label={t("adminManage.audit.searchUser")}
          value={userInput}
          onChange={(e) => setUserInput(e.target.value)}
          className="w-40 !h-[30px] !text-xs bg-zinc-800 border-zinc-700"
        />
        <Input
          placeholder={t("adminManage.audit.searchTargetPlaceholder")}
          aria-label={t("adminManage.audit.searchTarget")}
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
            className="flex items-center gap-1 px-2 py-1.5 rounded-md text-xs text-zinc-400 hover:text-zinc-100 bg-zinc-800 hover:bg-zinc-700 transition-colors"
          >
            <X size={12} /> {t("adminManage.audit.clear")}
          </button>
        )}
      </div>
    </div>
  );
}

function ExportButton({
  currentAction,
  currentGroup,
  currentDateFrom,
  currentDateTo,
  currentUser,
  currentTarget,
  currentHideCron,
}: {
  currentAction: string;
  currentGroup: string;
  currentDateFrom: string;
  currentDateTo: string;
  currentUser: string;
  currentTarget: string;
  currentHideCron: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);

  function exportAs(format: "csv" | "json") {
    const params = new URLSearchParams();
    params.set("format", format);
    if (currentAction) params.set("action", currentAction);
    if (currentGroup) params.set("group", currentGroup);
    if (currentDateFrom) params.set("dateFrom", currentDateFrom);
    if (currentDateTo) params.set("dateTo", currentDateTo);
    if (currentUser) params.set("user", currentUser);
    if (currentTarget) params.set("target", currentTarget);
    if (currentHideCron) params.set("hideCron", "1");
    window.open(withBasePath(`/api/admin/audit-log/export?${params.toString()}`), "_blank");
    setOpen(false);
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-zinc-800 text-zinc-400 hover:text-zinc-100 transition-colors"
      >
        <Download size={14} /> {t("adminManage.audit.export")}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-1 z-20 bg-zinc-800 border border-zinc-700 rounded-md shadow-lg overflow-hidden">
            <button onClick={() => exportAs("csv")} className="block w-full text-left px-4 py-2 text-xs text-zinc-300 hover:bg-zinc-700">
              {t("adminManage.audit.exportCsv")}
            </button>
            <button onClick={() => exportAs("json")} className="block w-full text-left px-4 py-2 text-xs text-zinc-300 hover:bg-zinc-700">
              {t("adminManage.audit.exportJson")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// Manual counterpart of the scrub-audit-pii cron: DELETE /api/admin/audit-log
// nulls IP/UA, redacts userName, and clears auth-event details on every row
// older than the configured retention window. Same handler the cron mirrors, so
// running it early is always safe — it can only do what the cron would do later.
function ScrubPiiButton() {
  const t = useT();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  async function runScrub() {
    setConfirming(false);
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch(withBasePath("/api/admin/audit-log"), { method: "DELETE" });
      const data = (await res.json().catch(() => ({}))) as {
        scrubbed?: number; detailsScrubbed?: number; retentionDays?: number; error?: string;
      };
      if (res.ok) {
        setResult({
          kind: "ok",
          text: t("adminManage.audit.scrubDone", { count: data.scrubbed ?? 0, days: data.retentionDays ?? 90 }),
        });
      } else {
        setResult({ kind: "err", text: data.error ?? t("adminManage.audit.scrubFailed") });
      }
    } catch {
      setResult({ kind: "err", text: t("adminManage.audit.scrubFailed") });
    }
    setBusy(false);
    setTimeout(() => setResult(null), 8000);
  }

  if (confirming) {
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-zinc-300">{t("adminManage.audit.scrubConfirm")}</span>
        <button
          onClick={runScrub}
          className="px-2.5 py-1.5 rounded-md text-xs font-medium bg-red-600 text-[var(--ds-on-status)] hover:bg-[var(--ds-danger-hover)] transition-colors"
        >
          {t("adminManage.audit.scrub")}
        </button>
        <button
          onClick={() => setConfirming(false)}
          className="px-2 py-1.5 rounded-md text-xs text-zinc-400 hover:text-zinc-100 bg-zinc-800 transition-colors"
        >
          {t("adminManage.common.cancel")}
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        onClick={() => setConfirming(true)}
        disabled={busy}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-zinc-800 text-zinc-400 hover:text-zinc-100 transition-colors disabled:opacity-50"
        title={t("adminManage.audit.scrubTitle")}
      >
        <Shield size={14} /> {busy ? t("adminManage.audit.scrubbing") : t("adminManage.audit.scrubPii")}
      </button>
      {result && (
        <span
          role={result.kind === "err" ? "alert" : "status"}
          aria-live={result.kind === "err" ? "assertive" : "polite"}
          className={`basis-full text-xs ${result.kind === "err" ? "text-red-400" : "text-green-400"}`}
        >
          {result.text}
        </span>
      )}
    </div>
  );
}

function formatSummary(action: string, d: Record<string, unknown>, t: Translator): string | null {
  // Plural lookups need a real number; a malformed payload counts as 0.
  const num = (v: unknown): number => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  const note = () => d.adminNote && t("adminManage.audit.summary.note", { note: String(d.adminNote).slice(0, 80) });
  const media = () => d.mediaType && `(${String(d.mediaType).toLowerCase()})`;
  const reason = () => d.reason && `— ${String(d.reason).slice(0, 80)}`;
  const via = () => d.provider && t("adminManage.audit.summary.via", { provider: String(d.provider) });
  switch (action) {
    case "REQUEST_APPROVE":
    case "REQUEST_DECLINE":
    case "REQUEST_DELETE":
      // The batch route logs a bulk approve or non-permanent decline under
      // these same actions, but with a {batch, count, ids} shape instead of a
      // single title. (A permanent bulk decline has its own case below.)
      if (d.batch) {
        return [
          t("adminManage.audit.summary.batch", { count: num(d.count) }),
          d.permanent && t("adminManage.audit.summary.permanent"),
          note(),
        ].filter(Boolean).join(" · ") || null;
      }
      return [
        d.title && `"${d.title}"`,
        media(),
        d.year && `[${d.year}]`,
        d.requestedBy && t("adminManage.audit.summary.requestedBy", { user: String(d.requestedBy) }),
      ].filter(Boolean).join(" ") || null;
    case "BATCH_REQUEST_DECLINE":
      return [
        t("adminManage.audit.summary.batchDeclined", { count: num(d.count) }),
        d.permanent && t("adminManage.audit.summary.permanent"),
        note(),
      ].filter(Boolean).join(" · ") || null;
    case "REQUEST_ON_BEHALF":
      return [
        d.created != null && t("adminManage.audit.summary.requestsCreated", { count: num(d.created) }),
        d.targetUser && t("adminManage.audit.summary.forUser", { user: String(d.targetUser) }),
      ].filter(Boolean).join(" ") || null;
    case "USER_ROLE_CHANGE":
    case "USER_PERMISSIONS_CHANGE":
      return [
        d.targetUser && t("adminManage.audit.summary.user", { user: String(d.targetUser) }),
        d.targetEmail && `(${d.targetEmail})`,
      ].filter(Boolean).join(" ") || null;
    case "USER_CREATE":
      return [
        d.targetUser && t("adminManage.audit.summary.created", { user: String(d.targetUser) }),
        d.targetEmail && `(${d.targetEmail})`,
        d.role && `· ${d.role}`,
      ].filter(Boolean).join(" ") || null;
    case "USER_DELETE":
      return [
        d.targetUser && t("adminManage.audit.summary.deletedUser", { user: String(d.targetUser) }),
        d.targetEmail && `(${d.targetEmail})`,
      ].filter(Boolean).join(" ") || null;
    case "USER_DEACTIVATE":
      return [
        d.targetUser ? t("adminManage.audit.summary.disabled", { user: String(d.targetUser) }) : null,
        d.targetEmail && `(${d.targetEmail})`,
        d.kind === "self-delete" && t("adminManage.audit.summary.closedByUser"),
      ].filter(Boolean).join(" ") || null;
    case "USER_REACTIVATE":
      return [
        d.targetUser && t("adminManage.audit.summary.reenabled", { user: String(d.targetUser) }),
        d.targetEmail && `(${d.targetEmail})`,
      ].filter(Boolean).join(" ") || null;
    case "USER_PURGE": {
      const kept = d.historyPreserved as Record<string, unknown> | undefined;
      return [
        d.targetUser && t("adminManage.audit.summary.purged", { user: String(d.targetUser) }),
        kept && t("adminManage.audit.summary.kept", {
          requests: num(kept.mediaRequests),
          issues: num(kept.issues),
          votes: num(kept.deletionVotes),
        }),
      ].filter(Boolean).join(" · ") || null;
    }
    case "SETTINGS_CHANGE":
    case "MAINTENANCE_TOGGLE": {
      const keys = d.keys as string[] | undefined;
      if (keys?.length) return t("adminManage.audit.summary.changed", { keys: keys.join(", ") });
      // Instance-manager saves ({service, instances[]}) and the PII scrub
      // ({scrubbed}) log under SETTINGS_CHANGE with their own shapes.
      if (d.service && Array.isArray(d.instances)) {
        const removed = Array.isArray(d.removed) && d.removed.length > 0
          ? ` · ${t("adminManage.audit.summary.removed", { list: (d.removed as unknown[]).join(", ") })}`
          : "";
        return `${d.service}: ${t("adminManage.audit.summary.instances", { count: (d.instances as unknown[]).length })}${removed}`;
      }
      if (d.scrubbed != null) return t("adminManage.audit.summary.scrubbedRows", { count: num(d.scrubbed) });
      // TRaSH sync also logs under SETTINGS_CHANGE, with its own shape
      // ({refreshed[], applied{count,failures}, errors[], durationMs}). Summarize
      // it in one line instead of dumping the whole `refreshed` array as JSON.
      if (Array.isArray(d.refreshed) || d.applied != null) {
        const applied = d.applied as { count?: number; failures?: number; recreated?: number } | undefined;
        const failures = applied?.failures ?? 0;
        const recreated = applied?.recreated ?? 0;
        const errors = Array.isArray(d.errors) ? d.errors.length : 0;
        return [
          Array.isArray(d.refreshed) && t("adminManage.audit.summary.refreshedServices", { count: d.refreshed.length }),
          applied?.count != null && t("adminManage.audit.summary.appliedSpecs", { count: num(applied.count) }),
          recreated > 0 && t("adminManage.audit.summary.recreated", { count: recreated }),
          failures > 0 && t("adminManage.audit.summary.failed", { count: failures }),
          errors > 0 && t("adminManage.audit.summary.errors", { count: errors }),
        ].filter(Boolean).join(" · ") || null;
      }
      return null;
    }
    case "ISSUE_STATUS_CHANGE":
    case "ISSUE_CLAIM":
    case "ISSUE_UNCLAIM":
      return d.title ? `"${d.title}"` : null;
    case "ISSUE_DELETE":
      return [
        d.title && `"${d.title}"`,
        media(),
      ].filter(Boolean).join(" ") || null;
    case "CONTENT_REPORT":
      return [
        d.contentType && d.contentId && `${d.contentType} #${d.contentId}`,
        reason(),
      ].filter(Boolean).join(" ") || null;
    case "VOTE_DISMISS_ALL":
      return [
        d.dismissedCount != null && t("adminManage.audit.summary.dismissedVotes", { count: num(d.dismissedCount) }),
        d.tmdbId && `tmdb:${d.tmdbId}`,
        media(),
      ].filter(Boolean).join(" ") || null;
    case "FIX_MATCH":
      return [
        d.source && `${d.source}:`,
        d.fromTmdbId && d.toTmdbId && `tmdb ${d.fromTmdbId} → ${d.toTmdbId}`,
        media(),
        d.serverInstance && t("adminManage.audit.summary.onInstance", { instance: String(d.serverInstance) }),
      ].filter(Boolean).join(" ") || null;
    case "SERVER_USERS_BULK":
      return [
        d.downloadsEnabled != null &&
          (d.downloadsEnabled
            ? t("adminManage.audit.summary.downloadsEnabled")
            : t("adminManage.audit.summary.downloadsDisabled")),
        d.targetCount != null && t("adminManage.audit.summary.forUsers", { count: num(d.targetCount) }),
        d.pushed != null && t("adminManage.audit.summary.pushed", { count: num(d.pushed) }),
      ].filter(Boolean).join(" ") || null;
    case "SERVER_USER_LINK": {
      const mode = d.mode === "auto"
        ? t("adminManage.audit.summary.linkAuto")
        : d.mode === "manual-unlink"
          ? t("adminManage.audit.summary.linkManualUnlink")
          : t("adminManage.audit.summary.linkManual");
      return [
        d.serverUser && `${d.serverUser}`,
        d.source && `(${d.source})`,
        `— ${mode}`,
      ].filter(Boolean).join(" ") || null;
    }
    case "PLEX_SESSION_TERMINATE":
    case "JELLYFIN_SESSION_TERMINATE":
      return [
        (d.mediaTitle ?? d.title) && `"${d.mediaTitle ?? d.title}"`,
        (d.accountName ?? d.userName) && `· ${d.accountName ?? d.userName}`,
        reason(),
      ].filter(Boolean).join(" ") || null;
    case "LIBRARY_SYNC":
      return [
        d.movies != null && t("adminManage.audit.summary.movies", { count: num(d.movies) }),
        d.tv != null && t("adminManage.audit.summary.tv", { count: num(d.tv) }),
        d.marked != null && t("adminManage.audit.summary.markedAvailable", { count: num(d.marked) }),
        d.full === true && t("adminManage.audit.summary.fullResync"),
        d.durationMs != null && t("adminManage.audit.summary.inSeconds", { seconds: Math.round(Number(d.durationMs) / 1000) }),
      ].filter(Boolean).join(" · ") || null;
    case "CACHE_WARM":
      return [
        d.warmed != null && t("adminManage.audit.summary.warmed", { count: num(d.warmed) }),
        d.fetched != null && t("adminManage.audit.summary.fetched", { count: num(d.fetched) }),
        d.skipped != null && t("adminManage.audit.summary.skipped", { count: num(d.skipped) }),
        d.trigger && `(${d.trigger})`,
      ].filter(Boolean).join(" · ") || null;
    case "RATINGS_CACHE_CLEAR":
      return [
        d.cleared != null && t("adminManage.audit.summary.clearedEntries", { count: num(d.cleared) }),
        d.source && `(${d.source})`,
      ].filter(Boolean).join(" ") || null;
    case "PLAY_HISTORY_BACKFILL":
      return [
        d.updated != null && t("adminManage.audit.summary.clampedRows", { count: num(d.updated) }),
        d.watchedFlippedToFalse != null && t("adminManage.audit.summary.watchedFlipped", { count: num(d.watchedFlippedToFalse) }),
      ].filter(Boolean).join(" · ") || null;
    case "PLAY_HISTORY_DELETE":
      return [
        d.title && `"${d.title}"`,
        d.source && `(${d.source})`,
      ].filter(Boolean).join(" ") || null;
    case "PLAY_HISTORY_EXPORT":
    case "AUDIT_LOG_EXPORT":
      return [
        d.format && t("adminManage.audit.summary.format", { format: String(d.format).toUpperCase() }),
        d.rowCount != null && Number(d.rowCount) > 0 && t("adminManage.audit.summary.rows", { count: num(d.rowCount) }),
        d.truncated === true && t("adminManage.audit.summary.truncated"),
        d.status && `(${d.status})`,
      ].filter(Boolean).join(" · ") || null;
    case "BLACKLIST_CHANGE":
      return [
        d.op === "remove" ? t("adminManage.audit.summary.unblocked") : t("adminManage.audit.summary.blocked"),
        d.title && `"${d.title}"`,
        reason(),
      ].filter(Boolean).join(" ") || null;
    case "LIBRARY_CLEANUP_DELETE":
      return [
        d.title && `"${d.title}"`,
        Array.isArray(d.deleted) && d.deleted.length > 0 && t("adminManage.audit.summary.removedFrom", { list: d.deleted.join(", ") }),
        Array.isArray(d.failed) && d.failed.length > 0 && t("adminManage.audit.summary.failedOn", { list: d.failed.join(", ") }),
        d.blacklisted === true && `· ${t("adminManage.audit.summary.blacklisted")}`,
      ].filter(Boolean).join(" ") || null;
    case "LIBRARY_CLEANUP_PROTECT":
      return [
        d.op === "remove" ? t("adminManage.audit.summary.unprotected") : t("adminManage.audit.summary.protected"),
        d.title && `"${d.title}"`,
        reason(),
      ].filter(Boolean).join(" ") || null;
    case "BACKUP_EXPORT":
      return [
        d.format && t("adminManage.audit.summary.format", { format: String(d.format).toUpperCase() }),
        d.totalRows != null && t("adminManage.audit.summary.rows", { count: num(d.totalRows) }),
        d.userCount != null && t("adminManage.audit.summary.usersAndRequests", { users: num(d.userCount), requests: num(d.requestCount) }),
        d.includeSensitive && t("adminManage.audit.summary.inclSensitive"),
      ].filter(Boolean).join(" · ") || null;
    case "BACKUP_IMPORT":
      return [
        d.format && t("adminManage.audit.summary.format", { format: String(d.format).toUpperCase() }),
      ].filter(Boolean).join(" · ") || null;
    case "AUTH_LOGIN":
      return [
        d.email && `${d.email}`,
        d.role && `(${d.role})`,
        via(),
      ].filter(Boolean).join(" ") || null;
    case "AUTH_LOGIN_FAILED":
      return [
        d.reason && t("adminManage.audit.summary.reason", { reason: String(d.reason).replace(/_/g, " ") }),
        via(),
      ].filter(Boolean).join(" · ") || null;
    case "AUTH_LOGOUT":
      return [
        d.email && `${d.email}`,
        via(),
      ].filter(Boolean).join(" ") || null;
    case "SESSION_REVOKE":
      return [
        d.targetUser
          ? t("adminManage.audit.summary.user", { user: String(d.targetUser) })
          : d.deviceLabel && t("adminManage.audit.summary.device", { device: String(d.deviceLabel) }),
        d.revokedAll && t("adminManage.audit.summary.allSessions"),
        d.adminAction && t("adminManage.audit.summary.byAdmin"),
        d.revokedByOwner && t("adminManage.audit.summary.byOwner"),
      ].filter(Boolean).join(" · ") || null;
    case "MFA_CHANGE":
      return [
        d.kind && String(d.kind).replace(/-/g, " "),
        d.name && `"${String(d.name)}"`,
        typeof d.otherSessionsRevoked === "number" && d.otherSessionsRevoked > 0 &&
          t("adminManage.audit.summary.otherSessionsSignedOut", { count: d.otherSessionsRevoked }),
      ].filter(Boolean).join(" · ") || null;
    case "MFA_RESET":
      return d.targetUser ? t("adminManage.audit.summary.user", { user: String(d.targetUser) }) : null;
    default:
      return null;
  }
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

function formatDiffSide(value: unknown, field: unknown, t: Translator): string | null {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return null;
    return entries.map(([k, v]) => `${k}: ${formatDiffValue(v, t)}`).join(", ");
  }
  const text = formatDiffValue(value, t);
  return typeof field === "string" && field ? `${field}: ${text}` : text;
}

function DetailSection({ details, action, expanded }: { details: string | null; action: string; expanded?: boolean }) {
  const t = useT();
  const [isExpanded, setIsExpanded] = useState(expanded ?? false);
  const parsed = parseDetails(details);
  if (!parsed) return <span className="text-zinc-500 text-xs">—</span>;

  const beforeText = "before" in parsed ? formatDiffSide(parsed.before, parsed.field, t) : null;
  const afterText = "after" in parsed ? formatDiffSide(parsed.after, parsed.field, t) : null;
  const hasDiff = beforeText !== null || afterText !== null;

  const summary = formatSummary(action, parsed, t);

  // Actions with no summary case (cron shapes, anything added later) keep their
  // raw payload behind the same expand toggle the diff rows use, so long JSON
  // doesn't push other entries off screen. Collapsed, the row shows just the
  // field names so it still says what it is.
  const rawEntries = !summary && !hasDiff ? Object.entries(parsed) : [];
  const hasRaw = rawEntries.length > 0;

  return (
    <div className="text-xs">
      {hasDiff || hasRaw ? (
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          aria-expanded={isExpanded}
          className="flex items-center gap-1 text-zinc-300 hover:text-zinc-100 transition-colors text-left"
        >
          {isExpanded ? <ChevronDown size={12} className="shrink-0" /> : <ChevronRight size={12} className="shrink-0" />}
          <span>
            {summary ||
              (hasDiff
                ? t("adminManage.audit.viewChanges")
                : t("adminManage.audit.fields", { count: rawEntries.length, list: rawEntries.map(([k]) => k).join(", ") }))}
          </span>
        </button>
      ) : (
        <span className="text-zinc-400">{summary}</span>
      )}

      {isExpanded && hasRaw && (
        <pre className="mt-2 pl-4 border-l-2 border-zinc-700/60 text-zinc-400 whitespace-pre-wrap break-words overflow-x-auto">
          {JSON.stringify(parsed, null, 2)}
        </pre>
      )}

      {isExpanded && hasDiff && (
        <div className="mt-2 pl-4 space-y-1.5 border-l-2 border-zinc-700/60">
          {beforeText !== null && (
            <div className="flex items-start gap-2">
              <span className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-red-500/15 text-red-400">{t("adminManage.audit.before")}</span>
              <span className="text-red-400">{beforeText}</span>
            </div>
          )}
          {afterText !== null && (
            <div className="flex items-start gap-2">
              <span className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-green-500/15 text-green-400">{t("adminManage.audit.after")}</span>
              <span className="text-green-400">{afterText}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function AuditLogTable({ logs, mounted }: { logs: AuditRow[]; mounted: boolean }) {
  const t = useT();
  const locale = useLocale();
  return (
    <Card className="bg-zinc-900 border-zinc-800 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-800 text-zinc-500 text-xs uppercase tracking-wider">
              {/* Hide Details + Source below the sm: breakpoint — they're the
                  lowest-information columns for a mobile glance (Source is
                  usually inferable from the Action verb; Details truncates
                  anyway). The wrapping overflow-x-auto div remains a safety net. */}
              <th scope="col" className="text-left px-4 py-3 font-medium">{t("adminManage.audit.col.time")}</th>
              <th scope="col" className="text-left px-4 py-3 font-medium">{t("adminManage.audit.col.user")}</th>
              <th scope="col" className="text-left px-4 py-3 font-medium">{t("adminManage.audit.col.action")}</th>
              <th scope="col" className="text-left px-4 py-3 font-medium">{t("adminManage.audit.col.target")}</th>
              <th scope="col" className="hidden sm:table-cell text-left px-4 py-3 font-medium">{t("adminManage.audit.col.details")}</th>
              <th scope="col" className="hidden sm:table-cell text-left px-4 py-3 font-medium">{t("adminManage.audit.col.source")}</th>
            </tr>
          </thead>
          <tbody>
            {logs.map((log) => {
              const actionInfo = ACTION_LABELS[log.action as AuditAction] ?? { label: log.action, color: "bg-zinc-800 text-zinc-400" };
              const label = actionLabel(log.action, t);
              return (
                <tr key={log.id} className="border-b border-zinc-800/50 hover:bg-zinc-800/30">
                  <td className="px-4 py-3 text-zinc-400 whitespace-nowrap text-xs" title={mounted ? new Date(log.createdAt).toLocaleString(locale) : undefined}>
                    {mounted ? relativeTime(log.createdAt, locale) : ""}
                  </td>
                  <td className="px-4 py-3 text-zinc-100 text-sm">{log.userName}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${actionInfo.color}`}>
                      {label}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-zinc-300 max-w-[200px] truncate text-xs font-mono">{log.target}</td>
                  <td className="hidden sm:table-cell px-4 py-3 max-w-[300px]">
                    <DetailSection details={log.details} action={log.action} />
                  </td>
                  <td className="hidden sm:table-cell px-4 py-3">
                    <div className="flex items-center gap-2 text-xs text-zinc-500">
                      {log.ipAddress && (
                        <span className="flex items-center gap-1" title={t("adminManage.audit.ipTitle", { ip: log.ipAddress })}>
                          <Globe size={11} /> {log.ipAddress}
                        </span>
                      )}
                      {log.provider && (
                        <span className="flex items-center gap-1" title={t("adminManage.audit.providerTitle", { provider: log.provider })}>
                          <Shield size={11} /> {log.provider}
                        </span>
                      )}
                      {log.userAgent && (
                        <span className="flex items-center gap-1" title={log.userAgent}>
                          <Monitor size={11} /> {parseUserAgent(log.userAgent, t)}
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
  const t = useT();
  const locale = useLocale();
  const groups: { date: string; logs: AuditRow[] }[] = [];
  let currentDate = "";

  for (const log of logs) {
    // Before mount, group rows by their UTC date: the server and the browser can
    // be in different time zones, so grouping by local date during SSR/hydration
    // could split rows near midnight differently on each side and cause a React
    // #418 hydration mismatch. The headings only render after mount, so once
    // mounted regroup by the viewer's LOCAL date — the same day formatDateGroup
    // labels — or one heading could span two local days and two neighbouring
    // groups could share a heading.
    const dateStr = mounted ? new Date(log.createdAt).toDateString() : log.createdAt.slice(0, 10);
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
            {mounted ? formatDateGroup(group.date, t, locale) : ""}
          </h3>
          <div className="relative pl-6">
            <div className="absolute left-[7px] top-2 bottom-2 w-px bg-zinc-800" />

            <div className="space-y-3">
              {group.logs.map((log) => {
                const actionInfo = ACTION_LABELS[log.action as AuditAction] ?? { label: log.action, color: "bg-zinc-800 text-zinc-400" };
                const dotColor = DOT_COLORS[log.action] ?? "bg-zinc-500";
                const label = actionLabel(log.action, t);

                return (
                  <div key={log.id} className="relative">
                    <div className={`absolute -left-6 top-2 w-[14px] h-[14px] rounded-full border-2 border-zinc-900 ${dotColor}`} />

                    <Card className="bg-zinc-900 border-zinc-800 p-3">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-medium text-zinc-100">{log.userName}</span>
                          <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${actionInfo.color}`}>
                            {label}
                          </span>
                          <span className="text-xs text-zinc-500 font-mono break-all">{log.target}</span>
                        </div>
                        <span className="text-xs text-zinc-500" title={mounted ? new Date(log.createdAt).toLocaleString(locale) : undefined}>
                          {mounted ? relativeTime(log.createdAt, locale) : ""}
                        </span>
                      </div>

                      <div className="mt-2">
                        <DetailSection details={log.details} action={log.action} />
                      </div>

                      {(log.ipAddress || log.provider || log.userAgent) && (
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2 text-[11px] text-zinc-500">
                          {log.ipAddress && (
                            <span className="flex min-w-0 items-center gap-1 break-all">
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
                              <Monitor size={10} /> {parseUserAgent(log.userAgent, t)}
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

// Audit-log viewer: filters + table/timeline toggle over cursor-paginated
// audit rows, with client-side "load more" appending to the initial SSR page.
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
  const [loadError, setLoadError] = useState(false);
  const [viewMode, setViewMode] = useState<"table" | "timeline">("table");
  const mounted = useHasMounted();
  const t = useT();

  useEffect(() => {
    // Storage access throws (SecurityError) with site data blocked or in some
    // private windows; a throw here unwinds to the error boundary and blanks
    // the page over a cosmetic preference.
    let saved: string | null = null;
    try {
      saved = localStorage.getItem("audit-log-view");
    } catch {}
    if (saved === "timeline" || saved === "table") setViewMode(saved);
  }, []);

  // A "generation" counter, bumped whenever a filter change brings in a new
  // server-rendered page. loadMore() remembers the value it started with, so a
  // slow response for the OLD filter can see it is stale and not append its rows
  // (or its cursor) under the new list.
  const filterGen = useRef(0);
  useEffect(() => {
    filterGen.current += 1;
    setLogs(initialLogs);
    setNextCursor(initialNextCursor);
    setHasMore(initialHasMore);
  }, [initialLogs, initialNextCursor, initialHasMore]);

  function handleViewModeChange(mode: "table" | "timeline") {
    setViewMode(mode);
    try {
      localStorage.setItem("audit-log-view", mode);
    } catch {}
  }

  async function loadMore() {
    if (!nextCursor || loading) return;
    const myGen = filterGen.current;
    setLoading(true);
    setLoadError(false);
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

      const res = await fetch(withBasePath(`/api/admin/audit-log?${params.toString()}`));
      if (!res.ok) {
        setLoadError(true);
        return;
      }
      const data = (await res.json()) as { logs: AuditRow[]; nextCursor: string | null; hasMore: boolean };
      if (filterGen.current !== myGen) return; // filters navigated mid-flight
      setLogs((prev) => [...prev, ...data.logs]);
      setNextCursor(data.nextCursor);
      setHasMore(data.hasMore);
    } catch {
      setLoadError(true);
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
            {t("adminManage.audit.empty")}
          </div>
        </Card>
      ) : viewMode === "table" ? (
        <AuditLogTable logs={logs} mounted={mounted} />
      ) : (
        <AuditLogTimeline logs={logs} mounted={mounted} />
      )}

      {hasMore && (
        <div className="flex flex-col items-center gap-2">
          <button
            onClick={loadMore}
            disabled={loading}
            className="px-4 py-2 rounded-md bg-zinc-800 text-zinc-300 hover:bg-zinc-700 text-sm disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? t("adminManage.common.loading") : loadError ? t("adminManage.common.retry") : t("adminManage.common.loadMore")}
          </button>
          {loadError && (
            <span className="text-xs text-red-400">{t("adminManage.audit.loadMoreError")}</span>
          )}
        </div>
      )}

      {!hasMore && logs.length > 0 && (
        <p className="text-center text-xs text-zinc-500">{t("adminManage.audit.entriesLoaded", { count: logs.length })}</p>
      )}
    </div>
  );
}
