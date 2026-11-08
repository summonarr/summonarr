"use client";

// The audit log's two views of its rows (audit-log-table.tsx): the table and
// the day-grouped timeline. A row is memoised and parses its details once, so
// "Load more" (and every other re-render of the page) re-renders only the rows
// that changed — however many pages are loaded.

import { memo, useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import { ChevronDown, ChevronRight, Monitor, Globe, Shield } from "@/components/icons";
import { formatRelativeTimeLocalized } from "@/lib/relative-time";
import { ACTION_COLORS } from "@/lib/audit-actions";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import type { Translator } from "@/lib/i18n/translate";
import { formatDiffSide, formatSummary, parseDetails } from "@/lib/audit-log-view";
import { actionInfo, type AuditRow } from "@/lib/audit-log-client";

// Human label for an action badge. The enum code itself is never translated;
// an unknown code (a newer server) falls back to the code.
export function actionLabel(action: string, t: Translator): string {
  return action in ACTION_COLORS ? t(`adminManage.audit.action.${action}`) : action;
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

// Where a row came from — IP, sign-in provider, client — in the table's column
// or under a timeline card.
function AuditSourceMeta({ log, variant }: { log: AuditRow; variant: "table" | "timeline" }) {
  const t = useT();
  const table = variant === "table";
  const iconSize = table ? 11 : 10;
  return (
    <div className={table ? "flex items-center gap-2 text-xs text-zinc-500" : "flex flex-wrap items-center gap-x-3 gap-y-1 mt-2 text-[11px] text-zinc-500"}>
      {log.ipAddress && (
        <span className={table ? "flex items-center gap-1" : "flex min-w-0 items-center gap-1 break-all"} title={table ? t("adminManage.audit.ipTitle", { ip: log.ipAddress }) : undefined}>
          <Globe size={iconSize} /> {log.ipAddress}
        </span>
      )}
      {log.provider && (
        <span className="flex items-center gap-1" title={table ? t("adminManage.audit.providerTitle", { provider: log.provider }) : undefined}>
          <Shield size={iconSize} /> {log.provider}
        </span>
      )}
      {log.userAgent && (
        <span className="flex items-center gap-1" title={table ? log.userAgent : undefined}>
          <Monitor size={iconSize} /> {parseUserAgent(log.userAgent, t)}
        </span>
      )}
    </div>
  );
}

// The details column: a one-line summary behind an expand toggle. Parsed once
// per row (and per language), never on every render of the page.
function DetailSection({ details, action }: { details: string | null; action: string }) {
  const t = useT();
  const [isExpanded, setIsExpanded] = useState(false);
  const view = useMemo(() => {
    const parsed = parseDetails(details);
    if (!parsed) return null;
    const beforeText = "before" in parsed ? formatDiffSide(parsed.before, parsed.field, t) : null;
    const afterText = "after" in parsed ? formatDiffSide(parsed.after, parsed.field, t) : null;
    return { parsed, beforeText, afterText, summary: formatSummary(action, parsed, t), entries: Object.entries(parsed) };
  }, [details, action, t]);
  if (!view) return <span className="text-zinc-500 text-xs">—</span>;
  const { parsed, beforeText, afterText, summary, entries } = view;
  const hasDiff = beforeText !== null || afterText !== null;

  // Every non-empty payload sits behind the expand toggle, so long JSON doesn't
  // push other entries off screen and nothing is out of reach: a summary cuts a
  // reason or note to 80 characters and leaves other fields out. Collapsed,
  // the row shows its summary, else "view changes" for a diff, else just the
  // field names (actions with no summary case — cron shapes, anything added
  // later) so it still says what it is. Expanded: the diff, else the raw JSON.
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

const TableRow = memo(function TableRow({ log, mounted, redactedUserName }: { log: AuditRow; mounted: boolean; redactedUserName: string }) {
  const t = useT();
  const locale = useLocale();
  return (
    <tr className="border-b border-zinc-800/50 hover:bg-zinc-800/30">
      <td className="px-4 py-3 text-zinc-400 whitespace-nowrap text-xs" title={mounted ? new Date(log.createdAt).toLocaleString(locale) : undefined}>
        {mounted ? relativeTime(log.createdAt, locale) : ""}
      </td>
      <td className="px-4 py-3">
        <UserName name={log.userName} redactedUserName={redactedUserName} className="text-zinc-100 text-sm" />
      </td>
      <td className="px-4 py-3">
        <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${actionInfo(log.action).color}`}>
          {actionLabel(log.action, t)}
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
        <AuditSourceMeta log={log} variant="table" />
      </td>
    </tr>
  );
});

export function AuditLogTable({ logs, mounted, redactedUserName }: { logs: AuditRow[]; mounted: boolean; redactedUserName: string }) {
  const t = useT();
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
            {logs.map((log) => (
              <TableRow key={log.id} log={log} mounted={mounted} redactedUserName={redactedUserName} />
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

const TimelineItem = memo(function TimelineItem({ log, mounted, redactedUserName }: { log: AuditRow; mounted: boolean; redactedUserName: string }) {
  const t = useT();
  const locale = useLocale();
  const info = actionInfo(log.action);
  return (
    <div className="relative">
      <div className={`absolute -left-6 top-2 w-[14px] h-[14px] rounded-full border-2 border-zinc-900 ${DOT_CLASS[dotToneOf(info.color)]}`} />

      <Card className="bg-zinc-900 border-zinc-800 p-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex items-center gap-2 flex-wrap">
            <UserName name={log.userName} redactedUserName={redactedUserName} className="text-sm font-medium text-zinc-100" />
            <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${info.color}`}>
              {actionLabel(log.action, t)}
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

        {(log.ipAddress || log.provider || log.userAgent) && <AuditSourceMeta log={log} variant="timeline" />}
      </Card>
    </div>
  );
});

// Consecutive rows by day. Before mount, by their UTC date: the server and the
// browser can be in different time zones, so grouping by local date during
// SSR/hydration could split rows near midnight differently on each side and
// cause a React #418 hydration mismatch. The headings only render after mount,
// so once mounted regroup by the viewer's LOCAL date — the same day
// formatDateGroup labels — or one heading could span two local days and two
// neighbouring groups could share a heading.
function groupByDay(logs: AuditRow[], mounted: boolean): { date: string; logs: AuditRow[] }[] {
  const groups: { date: string; logs: AuditRow[] }[] = [];
  let currentDate = "";
  for (const log of logs) {
    const dateStr = mounted ? new Date(log.createdAt).toDateString() : log.createdAt.slice(0, 10);
    if (dateStr !== currentDate) {
      currentDate = dateStr;
      groups.push({ date: log.createdAt, logs: [] });
    }
    groups[groups.length - 1].logs.push(log);
  }
  return groups;
}

export function AuditLogTimeline({ logs, mounted, redactedUserName }: { logs: AuditRow[]; mounted: boolean; redactedUserName: string }) {
  const t = useT();
  const locale = useLocale();
  const groups = useMemo(() => groupByDay(logs, mounted), [logs, mounted]);

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
              {group.logs.map((log) => (
                <TimelineItem key={log.id} log={log} mounted={mounted} redactedUserName={redactedUserName} />
              ))}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
