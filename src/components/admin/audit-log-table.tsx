"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/design";
import { List, Activity, Download, X, ChevronDown, ChevronRight, Monitor, Globe, Shield, Bot } from "@/components/icons";
import { useHasMounted } from "@/hooks/use-has-mounted";
import { formatRelativeTimeLocalized } from "@/lib/relative-time";
import { ACTION_LABELS, ACTION_GROUP, type AuditGroup } from "@/lib/audit-actions";
import type { AuditAction } from "@/generated/prisma";
import { withBasePath } from "@/lib/base-path";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import type { Translator } from "@/lib/i18n/translate";
import { AUDIT_VIEW_COOKIE, formatDiffSide, formatSummary, parseDetails, type AuditViewMode } from "@/lib/audit-log-view";

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

// The filter state the page renders, as the URL carries it ("" = not set).
// One shape for the filter bar, "Load more" and the export, so a new filter is
// added in one place; the param names are what the list and export routes read
// (audit-log-filter.ts).
export interface AuditFilters {
  action: string;
  group: string;
  dateFrom: string;
  dateTo: string;
  user: string;
  target: string;
  hideCron: boolean;
}

function filtersToParams(filters: AuditFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.action) params.set("action", filters.action);
  if (filters.group) params.set("group", filters.group);
  if (filters.dateFrom) params.set("dateFrom", filters.dateFrom);
  if (filters.dateTo) params.set("dateTo", filters.dateTo);
  if (filters.user) params.set("user", filters.user);
  if (filters.target) params.set("target", filters.target);
  if (filters.hideCron) params.set("hideCron", "1");
  return params;
}

function hasAnyFilter(filters: AuditFilters): boolean {
  return Boolean(
    filters.action || filters.group || filters.dateFrom || filters.dateTo || filters.user || filters.target || filters.hideCron,
  );
}

// The navigate() patch that removes every filter from the URL.
const CLEAR_ALL_FILTERS: Record<string, string> = {
  action: "", group: "", dateFrom: "", dateTo: "", user: "", target: "", hideCron: "",
};

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

// The Timeline dot takes its colour FROM the action chip rather than from a
// second hand-kept table: a per-action map covered 22 of 44 actions, so a red
// "User Data Purged" chip sat beside a grey dot, and its one fixed blue ignored
// the theme while the chip used the info token. The chip's text class names its
// status tone (guardrail 42's remapped shades), so a new action can never land
// with a dot that disagrees with its chip.
type DotTone = "danger" | "success" | "warning" | "info" | "accent" | "neutral";

function dotToneOf(chipColor: string): DotTone {
  if (/\btext-(?:red|rose)-/.test(chipColor)) return "danger";
  if (/\btext-(?:green|emerald)-/.test(chipColor)) return "success";
  if (/\btext-(?:yellow|amber|orange)-/.test(chipColor)) return "warning";
  if (/\btext-indigo-/.test(chipColor)) return "accent";
  if (/\btext-(?:sky|purple)-/.test(chipColor)) return "info";
  return "neutral";
}

// All remapped shades (--ds-danger/success/warning/info/accent); zinc-500 is
// the neutral rail colour the dot already used.
const DOT_CLASS: Record<DotTone, string> = {
  danger:  "bg-red-500",
  success: "bg-green-500",
  warning: "bg-amber-500",
  info:    "bg-sky-500",
  accent:  "bg-indigo-500",
  neutral: "bg-zinc-500",
};

// The PII scrub overwrites userName with a sentinel; shown as a muted,
// translated label instead of an English token dressed as an account name.
// The sentinel itself is REDACTED_USER_NAME in @/lib/audit — a server module —
// so the page passes it down rather than this client component importing it.
function UserName({ name, redactedUserName, className }: { name: string; redactedUserName: string; className: string }) {
  const t = useT();
  if (name === redactedUserName) {
    return <span className={`italic text-zinc-500 ${className}`}>{t("adminManage.audit.redacted")}</span>;
  }
  return <span className={className}>{name}</span>;
}

// Local-day bounds for the date filter. `<input type="date">` yields a plain
// YYYY-MM-DD, which `new Date()` on the server would read as UTC midnight —
// so a UTC-7 viewer filtering "from Oct 5" got rows from Oct 4 17:00 local,
// filed under an "Oct 4" heading by the Timeline view (which groups by LOCAL
// day). The URL and every API call instead carry the ISO instant of the start
// of the viewer's local day; the server adds one UTC day to `dateTo`.
function localDayStartIso(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return "";
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return isNaN(d.getTime()) ? "" : d.toISOString();
}

// Inverse for the input's value. A bare YYYY-MM-DD (an old bookmark) passes
// through. Depends on the viewer's time zone, so every callsite is mounted-
// gated (guardrail 16): the SSR server's zone could file the instant under a
// different calendar day than the browser's.
function isoToLocalDateInput(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const d = new Date(value);
  if (isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

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
  filters,
  viewMode,
  onViewModeChange,
}: {
  filters: AuditFilters;
  viewMode: AuditViewMode;
  onViewModeChange: (mode: AuditViewMode) => void;
}) {
  const {
    action: currentAction,
    group: currentGroup,
    dateFrom: currentDateFrom,
    dateTo: currentDateTo,
    user: currentUser,
    target: currentTarget,
    hideCron: currentHideCron,
  } = filters;
  const t = useT();
  const navigate = useAuditNav();
  const mounted = useHasMounted();
  const [userInput, setUserInput] = useState(currentUser);
  const [targetInput, setTargetInput] = useState(currentTarget);
  const userTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const targetTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // The search value the URL is expected to hold because of us — see the sync
  // effect below.
  const userUrlRef = useRef(currentUser);
  const targetUrlRef = useRef(currentTarget);

  const hasFilters = hasAnyFilter(filters);

  // The per-action pills show only once a group scopes them: all 44 at once
  // wrapped into ~12 rows at phone width before the table was even visible.
  // An action reached without a group (an old bookmark) still shows its own
  // group's pills so the active one stays visible and clearable.
  const pillGroup = currentGroup || (currentAction ? ACTION_GROUP[currentAction as AuditAction] ?? "" : "");
  const visibleActions = pillGroup
    ? ALL_ACTIONS.filter((a) => ACTION_GROUP[a as AuditAction] === pillGroup)
    : [];

  // Copy the URL value into the text box when the user presses Back/Forward.
  // That kind of navigation doesn't remount this component, so without this the
  // box keeps the old text while the list shows the URL's filter, and the next
  // keystroke pushes the old filter back — making Back useless on this page.
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

  // The debounce compares the box with what the URL is EXPECTED to hold, not
  // with the rendered prop: while a navigation is pending the prop is stale,
  // so after Clear a re-armed timer saw "" !== the old value and pushed the
  // old params minus this one over the clear, bringing the filters back.
  useEffect(() => {
    clearTimeout(userTimer.current);
    userTimer.current = setTimeout(() => {
      if (userInput !== userUrlRef.current) {
        userUrlRef.current = userInput;
        navigate({ user: userInput });
      }
    }, 500);
    return () => clearTimeout(userTimer.current);
  }, [userInput, navigate]);

  useEffect(() => {
    clearTimeout(targetTimer.current);
    targetTimer.current = setTimeout(() => {
      if (targetInput !== targetUrlRef.current) {
        targetUrlRef.current = targetInput;
        navigate({ target: targetInput });
      }
    }, 500);
    return () => clearTimeout(targetTimer.current);
  }, [targetInput, navigate]);

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
        {/* Always rendered (even empty) so the right-hand controls stay right-aligned. */}
        <div className="flex flex-wrap gap-1.5">
          {visibleActions.length > 0 && (
            <>
              <button
                onClick={() => navigate({ action: "" })}
                aria-pressed={!currentAction}
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
                  aria-pressed={currentAction === a}
                  className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                    currentAction === a ? "bg-indigo-600 text-[var(--ds-accent-fg)]" : "bg-zinc-800 text-zinc-400 hover:text-zinc-100"
                  }`}
                >
                  {actionLabel(a, t)}
                </button>
              ))}
            </>
          )}
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

          <ExportButton filters={filters} />

          <ScrubPiiButton />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1.5">
          <label htmlFor="audit-date-from" className="text-xs text-zinc-500">{t("adminManage.audit.from")}</label>
          <input
            id="audit-date-from"
            type="date"
            value={mounted ? isoToLocalDateInput(currentDateFrom) : ""}
            onChange={(e) => navigate({ dateFrom: localDayStartIso(e.target.value) })}
            className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-xs text-zinc-300 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:[color-scheme:dark]"
          />
        </div>
        <div className="flex items-center gap-1.5">
          <label htmlFor="audit-date-to" className="text-xs text-zinc-500">{t("adminManage.audit.to")}</label>
          <input
            id="audit-date-to"
            type="date"
            value={mounted ? isoToLocalDateInput(currentDateTo) : ""}
            onChange={(e) => navigate({ dateTo: localDayStartIso(e.target.value) })}
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
              clearTimeout(userTimer.current);
              clearTimeout(targetTimer.current);
              userUrlRef.current = "";
              targetUrlRef.current = "";
              setUserInput("");
              setTargetInput("");
              navigate(CLEAR_ALL_FILTERS);
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

function ExportButton({ filters }: { filters: AuditFilters }) {
  const t = useT();
  const [open, setOpen] = useState(false);

  // Escape dismisses the menu wherever focus is — the backdrop only answers to
  // a click, which left keyboard users with no way to close it.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  function exportAs(format: "csv" | "json") {
    const params = filtersToParams(filters);
    params.set("format", format);
    window.open(withBasePath(`/api/admin/audit-log/export?${params.toString()}`), "_blank");
    setOpen(false);
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-zinc-800 text-zinc-400 hover:text-zinc-100 transition-colors"
      >
        <Download size={14} /> {t("adminManage.audit.export")}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div role="menu" className="absolute right-0 top-full mt-1 z-20 bg-zinc-800 border border-zinc-700 rounded-md shadow-lg overflow-hidden">
            <button role="menuitem" onClick={() => exportAs("csv")} className="block w-full text-left px-4 py-2 text-xs text-zinc-300 hover:bg-zinc-700">
              {t("adminManage.audit.exportCsv")}
            </button>
            <button role="menuitem" onClick={() => exportAs("json")} className="block w-full text-left px-4 py-2 text-xs text-zinc-300 hover:bg-zinc-700">
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
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  // One dismiss timer at a time: a second scrub within 8 s had its result
  // wiped early by the first one's timer.
  const dismissTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(dismissTimer.current), []);

  async function runScrub() {
    clearTimeout(dismissTimer.current);
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
        // The rows on screen still show the IPs, user agents and names the
        // scrub just removed: re-render the server page (AuditLogView resets
        // to its fresh first page when the props change).
        router.refresh();
      } else {
        setResult({ kind: "err", text: data.error ?? t("adminManage.audit.scrubFailed") });
      }
    } catch {
      setResult({ kind: "err", text: t("adminManage.audit.scrubFailed") });
    }
    setBusy(false);
    dismissTimer.current = setTimeout(() => setResult(null), 8000);
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

function DetailSection({ details, action }: { details: string | null; action: string }) {
  const t = useT();
  const [isExpanded, setIsExpanded] = useState(false);
  const parsed = parseDetails(details);
  if (!parsed) return <span className="text-zinc-500 text-xs">—</span>;

  const beforeText = "before" in parsed ? formatDiffSide(parsed.before, parsed.field, t) : null;
  const afterText = "after" in parsed ? formatDiffSide(parsed.after, parsed.field, t) : null;
  const hasDiff = beforeText !== null || afterText !== null;

  const summary = formatSummary(action, parsed, t);

  // Every non-empty payload sits behind the expand toggle, so long JSON doesn't
  // push other entries off screen and nothing is out of reach: a summary cuts a
  // reason or note to 80 characters and leaves other fields out. Collapsed,
  // the row shows its summary, else "view changes" for a diff, else just the
  // field names (actions with no summary case — cron shapes, anything added
  // later) so it still says what it is. Expanded: the diff, else the raw JSON.
  const entries = Object.entries(parsed);
  const hasRaw = !hasDiff && entries.length > 0;

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
                : t("adminManage.audit.fields", { count: entries.length, list: entries.map(([k]) => k).join(", ") }))}
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

function AuditLogTable({ logs, mounted, redactedUserName }: { logs: AuditRow[]; mounted: boolean; redactedUserName: string }) {
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
                  <td className="px-4 py-3">
                    <UserName name={log.userName} redactedUserName={redactedUserName} className="text-zinc-100 text-sm" />
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${actionInfo.color}`}>
                      {label}
                    </span>
                  </td>
                  {/* max-width on a <td> is ignored in auto table layout, so the
                      bound lives on an inner block: without it a long target
                      never ellipsized and widened the table past its wrapper. */}
                  <td className="px-4 py-3 text-zinc-300 text-xs font-mono">
                    <div className="max-w-[200px] truncate" title={log.target}>{log.target}</div>
                  </td>
                  <td className="hidden sm:table-cell px-4 py-3">
                    <div className="max-w-[300px]">
                      <DetailSection details={log.details} action={log.action} />
                    </div>
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

function AuditLogTimeline({ logs, mounted, redactedUserName }: { logs: AuditRow[]; mounted: boolean; redactedUserName: string }) {
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
                const dotColor = DOT_CLASS[dotToneOf(actionInfo.color)];
                const label = actionLabel(log.action, t);

                return (
                  <div key={log.id} className="relative">
                    <div className={`absolute -left-6 top-2 w-[14px] h-[14px] rounded-full border-2 border-zinc-900 ${dotColor}`} />

                    <Card className="bg-zinc-900 border-zinc-800 p-3">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="flex items-center gap-2 flex-wrap">
                          <UserName name={log.userName} redactedUserName={redactedUserName} className="text-sm font-medium text-zinc-100" />
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

// The Table/Timeline choice: the cookie the page reads for the first paint,
// plus the localStorage copy older builds read (and the fallback if the cookie
// is cleared). Both writes are guarded — either can throw with site data
// blocked, and a cosmetic preference must never blank the page.
const VIEW_STORAGE_KEY = "audit-log-view";

function saveViewMode(mode: AuditViewMode) {
  try {
    const secure = location.protocol === "https:" ? "; Secure" : "";
    document.cookie = `${AUDIT_VIEW_COOKIE}=${mode}; Max-Age=${60 * 60 * 24 * 365}; Path=/; SameSite=Lax${secure}`;
  } catch {}
  try {
    localStorage.setItem(VIEW_STORAGE_KEY, mode);
  } catch {}
}

// Audit-log viewer: filters + table/timeline toggle over cursor-paginated
// audit rows, with client-side "load more" appending to the initial SSR page.
export function AuditLogView({
  initialLogs,
  initialNextCursor,
  initialHasMore,
  filters,
  initialViewMode,
  redactedUserName,
}: {
  initialLogs: AuditRow[];
  initialNextCursor: string | null;
  initialHasMore: boolean;
  filters: AuditFilters;
  /** The saved view from the AUDIT_VIEW_COOKIE cookie; null when there is none yet. */
  initialViewMode: AuditViewMode | null;
  /** The PII scrub's userName sentinel (REDACTED_USER_NAME, a server-side constant). */
  redactedUserName: string;
}) {
  const navigate = useAuditNav();
  const hasFilters = hasAnyFilter(filters);
  const [logs, setLogs] = useState(initialLogs);
  const [nextCursor, setNextCursor] = useState(initialNextCursor);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [viewMode, setViewMode] = useState<AuditViewMode>(initialViewMode ?? "table");
  const mounted = useHasMounted();
  const t = useT();

  useEffect(() => {
    // Only while there is no cookie: a choice saved before the cookie existed
    // lives in localStorage alone. Adopt it once and write the cookie, so the
    // server renders it directly from the next load on.
    if (initialViewMode !== null) return;
    // Storage access throws (SecurityError) with site data blocked or in some
    // private windows; a throw here unwinds to the error boundary and blanks
    // the page over a cosmetic preference.
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(VIEW_STORAGE_KEY);
    } catch {}
    if (saved === "timeline" || saved === "table") {
      setViewMode(saved);
      saveViewMode(saved);
    }
  }, [initialViewMode]);

  // A "generation" counter, bumped whenever a filter change brings in a new
  // server-rendered page. loadMore() remembers the value it started with, so a
  // slow response for the OLD filter can see it is stale and not append its rows
  // (or its cursor, or its error) under the new list.
  const filterGen = useRef(0);
  useEffect(() => {
    filterGen.current += 1;
    setLogs(initialLogs);
    setNextCursor(initialNextCursor);
    setHasMore(initialHasMore);
    setLoadError(false);
  }, [initialLogs, initialNextCursor, initialHasMore]);

  function handleViewModeChange(mode: AuditViewMode) {
    setViewMode(mode);
    saveViewMode(mode);
  }

  async function loadMore() {
    if (!nextCursor || loading) return;
    const myGen = filterGen.current;
    setLoading(true);
    setLoadError(false);
    try {
      const params = filtersToParams(filters);
      params.set("cursor", nextCursor);

      const res = await fetch(withBasePath(`/api/admin/audit-log?${params.toString()}`));
      if (filterGen.current !== myGen) return; // filters navigated mid-flight
      if (!res.ok) {
        setLoadError(true);
        return;
      }
      const data = (await res.json()) as { logs: AuditRow[]; nextCursor: string | null; hasMore: boolean };
      if (filterGen.current !== myGen) return;
      setLogs((prev) => [...prev, ...data.logs]);
      setNextCursor(data.nextCursor);
      setHasMore(data.hasMore);
    } catch {
      if (filterGen.current === myGen) setLoadError(true);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <AuditLogFilters
        filters={filters}
        viewMode={viewMode}
        onViewModeChange={handleViewModeChange}
      />

      {logs.length === 0 ? (
        <EmptyState
          icon={List}
          title={t("adminManage.audit.empty")}
          description={hasFilters ? t("adminManage.audit.emptyFiltered") : undefined}
          action={
            hasFilters ? (
              <button
                onClick={() => navigate(CLEAR_ALL_FILTERS)}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md text-xs text-zinc-400 hover:text-zinc-100 bg-zinc-800 hover:bg-zinc-700 transition-colors"
              >
                <X size={12} /> {t("adminManage.audit.clear")}
              </button>
            ) : undefined
          }
        />
      ) : viewMode === "table" ? (
        <AuditLogTable logs={logs} mounted={mounted} redactedUserName={redactedUserName} />
      ) : (
        <AuditLogTimeline logs={logs} mounted={mounted} redactedUserName={redactedUserName} />
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
