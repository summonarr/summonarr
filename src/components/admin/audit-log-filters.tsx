"use client";

// The audit log's filter bar (audit-log-table.tsx): the group and action pills,
// "hide cron", the Table/Timeline switch, Export, Scrub PII, the date boxes and
// the user/target searches. The filter state lives in the URL; the pure halves
// are src/lib/audit-log-client.ts.

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Input } from "@/components/ui/input";
import { List, Activity, Download, X, Shield, Bot } from "@/components/icons";
import { useHasMounted } from "@/hooks/use-has-mounted";
import { ACTION_COLORS, ACTION_GROUP, type AuditGroup } from "@/lib/audit-actions";
import type { AuditAction } from "@/generated/prisma";
import { withBasePath } from "@/lib/base-path";
import { fetchJson } from "@/lib/client/fetch-json";
import { v } from "@/lib/validate";
import { useT } from "@/components/i18n/i18n-provider";
import type { AuditViewMode } from "@/lib/audit-log-view";
import {
  CLEAR_ALL_FILTERS, dateFromParam, dateInputValue, dateToParam, filtersToParams, hasAnyFilter, type AuditFilters,
} from "@/lib/audit-log-client";
import { actionLabel } from "@/components/admin/audit-log-rows";

// ACTION_COLORS and ACTION_GROUP come from @/lib/audit-actions so every screen
// shares one list. Both are keyed by the AuditAction type, so adding an action
// to the schema forces a colour and group to be added too.
const ALL_ACTIONS = Object.keys(ACTION_COLORS);

const GROUP_OPTIONS: { value: AuditGroup | ""; labelKey: string }[] = [
  { value: "", labelKey: "adminManage.audit.group.all" },
  { value: "auth", labelKey: "adminManage.audit.group.auth" },
  { value: "admin", labelKey: "adminManage.audit.group.admin" },
  { value: "system", labelKey: "adminManage.audit.group.system" },
];

// A pill's (and a toggle's) on/off colours.
const pillClass = (active: boolean) =>
  active ? "bg-indigo-600 text-[var(--ds-accent-fg)]" : "bg-zinc-800 text-zinc-400 hover:text-zinc-100";

// How long a typed filter (text or a date) rests before it reaches the URL.
const TYPED_FILTER_DEBOUNCE_MS = 500;

// Filter changes navigate the page. A click (a pill, "hide cron", Clear) is a
// step of its own and pushes a history entry; a TYPED filter replaces the
// entry it refines, so Back doesn't walk through every word and date typed.
export function useAuditNav() {
  const router = useRouter();
  const searchParams = useSearchParams();
  return useCallback(function navigate(params: Record<string, string>, opts?: { replace?: boolean }) {
    const sp = new URLSearchParams(searchParams.toString());
    for (const [k, v] of Object.entries(params)) {
      if (v) sp.set(k, v);
      else sp.delete(k);
    }
    const href = `/admin/audit-log?${sp.toString()}`;
    if (opts?.replace) router.replace(href);
    else router.push(href);
  }, [router, searchParams]);
}

// One typed filter box held against its URL param.
//
// The box follows the URL when the URL changes under it (Back/Forward doesn't
// remount this component), but not when the change is one this box made: the
// server response arrives after the debounce, so copying it back would wipe
// anything typed while it loaded. And the debounce compares the box with what
// the URL is EXPECTED to hold, not with the rendered prop: while a navigation
// is pending the prop is stale, so after Clear a re-armed timer saw "" !== the
// old value and pushed the old params minus this one over the clear, bringing
// the filters back. `toUrl` answers null for a value that isn't one yet (a
// date still being typed): the URL is left alone.
function useUrlField(
  urlValue: string,
  toInput: (url: string) => string,
  toUrl: (input: string) => string | null,
  commit: (url: string) => void,
) {
  const [input, setInput] = useState(() => toInput(urlValue));
  const expected = useRef(urlValue);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (urlValue === expected.current) return;
    expected.current = urlValue;
    setInput(toInput(urlValue));
  }, [urlValue, toInput]);

  useEffect(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (input === toInput(expected.current)) return;
      const next = toUrl(input);
      if (next === null) return;
      expected.current = next;
      commit(next);
    }, TYPED_FILTER_DEBOUNCE_MS);
    return () => clearTimeout(timer.current);
  }, [input, toInput, toUrl, commit]);

  const reset = useCallback(() => {
    clearTimeout(timer.current);
    expected.current = "";
    setInput("");
  }, []);

  return { input, setInput, reset };
}

const sameText = (s: string) => s;

export function AuditLogFilters({
  filters,
  viewMode,
  onViewModeChange,
  onScrubbed,
}: {
  filters: AuditFilters;
  viewMode: AuditViewMode;
  onViewModeChange: (mode: AuditViewMode) => void;
  /** A scrub finished: the rows on screen still show what it removed. */
  onScrubbed: () => void;
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
  const user = useUrlField(currentUser, sameText, sameText, useCallback((value) => navigate({ user: value }, { replace: true }), [navigate]));
  const target = useUrlField(currentTarget, sameText, sameText, useCallback((value) => navigate({ target: value }, { replace: true }), [navigate]));
  const dateFrom = useUrlField(currentDateFrom, dateInputValue, dateFromParam, useCallback((value) => navigate({ dateFrom: value }, { replace: true }), [navigate]));
  const dateTo = useUrlField(currentDateTo, dateInputValue, dateToParam, useCallback((value) => navigate({ dateTo: value }, { replace: true }), [navigate]));

  const hasFilters = hasAnyFilter(filters);

  // The per-action pills show only once a group scopes them: all 44 at once
  // wrapped into ~12 rows at phone width before the table was even visible.
  // An action reached without a group (an old bookmark) still shows its own
  // group's pills so the active one stays visible and clearable.
  const pillGroup = currentGroup || (currentAction ? ACTION_GROUP[currentAction as AuditAction] ?? "" : "");

  function clearAll() {
    for (const field of [user, target, dateFrom, dateTo]) field.reset();
    navigate(CLEAR_ALL_FILTERS);
  }

  return (
    <div className="space-y-3">
      <GroupTabs currentGroup={currentGroup} onPick={(group) => navigate({ group, action: "" })} />

      <div className="flex flex-wrap items-center justify-between gap-2">
        {/* Always rendered (even empty) so the right-hand controls stay right-aligned. */}
        <div className="flex flex-wrap gap-1.5">
          <ActionPills group={pillGroup} currentAction={currentAction} onPick={(action) => navigate({ action })} />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => navigate({ hideCron: currentHideCron ? "" : "1" })}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${pillClass(currentHideCron)}`}
            title={currentHideCron ? t("adminManage.audit.cronHiddenTitle") : t("adminManage.audit.hideCronTitle")}
          >
            <Bot size={14} /> {currentHideCron ? t("adminManage.audit.cronHidden") : t("adminManage.audit.hideCron")}
          </button>

          <div className="flex rounded-md border border-zinc-700 overflow-hidden">
            <button
              onClick={() => onViewModeChange("table")}
              className={`p-1.5 transition-colors ${pillClass(viewMode === "table")}`}
              title={t("adminManage.audit.tableView")}
              aria-label={t("adminManage.audit.tableView")}
            >
              <List size={16} />
            </button>
            <button
              onClick={() => onViewModeChange("timeline")}
              className={`p-1.5 transition-colors ${pillClass(viewMode === "timeline")}`}
              title={t("adminManage.audit.timelineView")}
              aria-label={t("adminManage.audit.timelineView")}
            >
              <Activity size={16} />
            </button>
          </div>

          <ExportButton filters={filters} />

          <ScrubPiiButton onScrubbed={onScrubbed} />
        </div>
      </div>

      <TypedFilters
        mounted={mounted}
        fields={{ user, target, dateFrom, dateTo }}
        onClear={hasFilters ? clearAll : null}
      />
    </div>
  );
}

// All / Sign-in / Admin / System.
function GroupTabs({ currentGroup, onPick }: { currentGroup: string; onPick: (group: string) => void }) {
  const t = useT();
  return (
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
            onClick={() => onPick(g.value)}
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
  );
}

// The per-action pills of one group (none without a group), with "All" first.
function ActionPills({ group, currentAction, onPick }: { group: string; currentAction: string; onPick: (action: string) => void }) {
  const t = useT();
  const visibleActions = group ? ALL_ACTIONS.filter((a) => ACTION_GROUP[a as AuditAction] === group) : [];
  if (visibleActions.length === 0) return null;
  return (
    <>
      <button
        onClick={() => onPick("")}
        aria-pressed={!currentAction}
        className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${pillClass(!currentAction)}`}
      >
        {t("adminManage.audit.group.all")}
      </button>
      {visibleActions.map((a) => (
        <button
          key={a}
          onClick={() => onPick(a)}
          aria-pressed={currentAction === a}
          className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${pillClass(currentAction === a)}`}
        >
          {actionLabel(a, t)}
        </button>
      ))}
    </>
  );
}

type TypedField = ReturnType<typeof useUrlField>;

// The date boxes, the user and target searches, and Clear. The date boxes
// render empty until mount: their value depends on the viewer's time zone
// (guardrail 16).
function TypedFilters({ mounted, fields, onClear }: {
  mounted: boolean;
  fields: { user: TypedField; target: TypedField; dateFrom: TypedField; dateTo: TypedField };
  onClear: (() => void) | null;
}) {
  const t = useT();
  const { user, target, dateFrom, dateTo } = fields;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex items-center gap-1.5">
        <label htmlFor="audit-date-from" className="text-xs text-zinc-500">{t("adminManage.audit.from")}</label>
        <input
          id="audit-date-from"
          type="date"
          value={mounted ? dateFrom.input : ""}
          onChange={(e) => dateFrom.setInput(e.target.value)}
          className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-xs text-zinc-300 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:[color-scheme:dark]"
        />
      </div>
      <div className="flex items-center gap-1.5">
        <label htmlFor="audit-date-to" className="text-xs text-zinc-500">{t("adminManage.audit.to")}</label>
        <input
          id="audit-date-to"
          type="date"
          value={mounted ? dateTo.input : ""}
          onChange={(e) => dateTo.setInput(e.target.value)}
          className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-xs text-zinc-300 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:[color-scheme:dark]"
        />
      </div>
      <Input
        placeholder={t("adminManage.audit.searchUserPlaceholder")}
        aria-label={t("adminManage.audit.searchUser")}
        value={user.input}
        onChange={(e) => user.setInput(e.target.value)}
        className="w-40 !h-[30px] !text-xs bg-zinc-800 border-zinc-700"
      />
      <Input
        placeholder={t("adminManage.audit.searchTargetPlaceholder")}
        aria-label={t("adminManage.audit.searchTarget")}
        value={target.input}
        onChange={(e) => target.setInput(e.target.value)}
        className="w-40 !h-[30px] !text-xs bg-zinc-800 border-zinc-700"
      />
      {onClear && (
        <button
          onClick={onClear}
          className="flex items-center gap-1 px-2 py-1.5 rounded-md text-xs text-zinc-400 hover:text-zinc-100 bg-zinc-800 hover:bg-zinc-700 transition-colors"
        >
          <X size={12} /> {t("adminManage.audit.clear")}
        </button>
      )}
    </div>
  );
}

function ExportButton({ filters }: { filters: AuditFilters }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const wasOpen = useRef(false);

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

  // A menu takes focus on its first item when it opens, and gives it back to
  // the button that opened it when it closes (Escape, a choice, the backdrop).
  useEffect(() => {
    if (open) {
      wasOpen.current = true;
      itemRefs.current[0]?.focus();
    } else if (wasOpen.current) {
      wasOpen.current = false;
      triggerRef.current?.focus();
    }
  }, [open]);

  // Up and Down move between the items, wrapping at either end.
  function onMenuKey(e: { key: string; preventDefault(): void }) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = itemRefs.current.filter((x): x is HTMLButtonElement => x !== null);
    if (items.length === 0) return;
    const at = items.findIndex((x) => x === document.activeElement);
    const next = e.key === "ArrowDown" ? (at + 1) % items.length : (at <= 0 ? items.length : at) - 1;
    items[next].focus();
  }

  function exportAs(format: "csv" | "json") {
    const params = filtersToParams(filters);
    params.set("format", format);
    window.open(withBasePath(`/api/admin/audit-log/export?${params.toString()}`), "_blank");
    setOpen(false);
  }

  return (
    <div className="relative">
      <button
        ref={triggerRef}
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
          <div role="menu" onKeyDown={onMenuKey} className="absolute right-0 top-full mt-1 z-20 bg-zinc-800 border border-zinc-700 rounded-md shadow-lg overflow-hidden">
            <button ref={(el) => { itemRefs.current[0] = el; }} role="menuitem" onClick={() => exportAs("csv")} className="block w-full text-left px-4 py-2 text-xs text-zinc-300 hover:bg-zinc-700">
              {t("adminManage.audit.exportCsv")}
            </button>
            <button ref={(el) => { itemRefs.current[1] = el; }} role="menuitem" onClick={() => exportAs("json")} className="block w-full text-left px-4 py-2 text-xs text-zinc-300 hover:bg-zinc-700">
              {t("adminManage.audit.exportJson")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// The scrub's answer; each count is null when the server could not say.
const ScrubAnswer = v.object({
  scrubbed: v.optional(v.nullable(v.number())),
  detailsScrubbed: v.optional(v.nullable(v.number())),
  retentionDays: v.optional(v.number()),
});

// Manual counterpart of the scrub-audit-pii cron: DELETE /api/admin/audit-log
// nulls IP/UA, redacts userName, and clears auth-event details on every row
// older than the configured retention window. Same handler the cron mirrors, so
// running it early is always safe — it can only do what the cron would do later.
//
// Each step swaps the focused button out of the tree, so focus is moved by
// hand, as in DeletePlayButton: onto Cancel (never the destructive Scrub) when
// the confirm opens, and back to the trigger once it closes and the scrub has
// finished — unless the admin has put focus somewhere else meanwhile.
function ScrubPiiButton({ onScrubbed }: { onScrubbed: () => void }) {
  const t = useT();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const stepped = useRef(false);
  // One dismiss timer at a time: a second scrub within 8 s had its result
  // wiped early by the first one's timer.
  const dismissTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(dismissTimer.current), []);

  useEffect(() => {
    if (!stepped.current) return;
    if (confirming) {
      cancelRef.current?.focus();
      return;
    }
    const active = document.activeElement;
    if (!busy && (!active || active === document.body)) triggerRef.current?.focus();
  }, [confirming, busy]);

  function step(next: boolean) {
    stepped.current = true;
    setConfirming(next);
  }

  async function runScrub() {
    clearTimeout(dismissTimer.current);
    step(false);
    setBusy(true);
    setResult(null);
    const res = await fetchJson(withBasePath("/api/admin/audit-log"), {
      init: { method: "DELETE" },
      schema: ScrubAnswer,
      // It rewrites every row past the retention window, in batches: no client deadline.
      timeoutMs: Infinity,
      fallbackError: t("adminManage.audit.scrubFailed"),
    });
    if (res.ok) {
      const done = t("adminManage.audit.scrubDone", { count: res.data.scrubbed ?? 0, days: res.data.retentionDays ?? 90 });
      const details = res.data.detailsScrubbed ?? 0;
      setResult({
        kind: "ok",
        text: details > 0 ? `${done} · ${t("adminManage.audit.scrubDetailsCleared", { count: details })}` : done,
      });
      // The rows on screen still show the IPs, user agents and names the
      // scrub just removed: the list re-reads them.
      onScrubbed();
    } else {
      setResult({ kind: "err", text: res.error });
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
          ref={cancelRef}
          onClick={() => step(false)}
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
        ref={triggerRef}
        onClick={() => step(true)}
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
