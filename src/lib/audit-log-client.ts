// The admin audit-log viewer's pure halves (components/admin/audit-log-*.tsx):
// the filter state and its URL form, the date boxes' conversions, an action's
// badge, and the checked read of a list page. No React; tested in
// tests/audit-log-client.test.mts.
import { check, v, type Infer } from "./validate";
import { ACTION_COLORS } from "./audit-actions";
import type { AuditAction } from "@/generated/prisma";

// One row as the list route answers it (a Prisma row) and the page renders it;
// any other field is dropped.
const AuditRowSchema = v.object({
  id: v.string(),
  createdAt: v.string(),
  userName: v.string(),
  action: v.string(),
  target: v.string(),
  details: v.nullable(v.string()),
  ipAddress: v.nullable(v.string()),
  userAgent: v.nullable(v.string()),
  provider: v.nullable(v.string()),
});
export type AuditRow = Infer<typeof AuditRowSchema>;

/** A "Load more" page of GET /api/admin/audit-log. */
export const AuditPageSchema = v.object({
  logs: v.array(AuditRowSchema),
  nextCursor: v.nullable(v.string()),
  hasMore: v.boolean(),
});
export type AuditPage = Infer<typeof AuditPageSchema>;

export function auditPageFrom(body: unknown): AuditPage | null {
  const parsed = check(AuditPageSchema, body);
  return parsed.ok ? parsed.value : null;
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

export function filtersToParams(filters: AuditFilters): URLSearchParams {
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

export function hasAnyFilter(filters: AuditFilters): boolean {
  return Boolean(
    filters.action || filters.group || filters.dateFrom || filters.dateTo || filters.user || filters.target || filters.hideCron,
  );
}

/** The navigate() patch that removes every filter from the URL. */
export const CLEAR_ALL_FILTERS: Record<string, string> = {
  action: "", group: "", dateFrom: "", dateTo: "", user: "", target: "", hideCron: "",
};

// ── the date boxes ──────────────────────────────────────────────────────────
// `<input type="date">` yields a plain YYYY-MM-DD, which `new Date()` on the
// server would read as UTC midnight — so a UTC-7 viewer filtering "from Oct 5"
// got rows from Oct 4 17:00 local, filed under an "Oct 4" heading by the
// Timeline view (which groups by LOCAL day). The URL and every API call carry
// ISO instants worked out in the viewer's own zone instead.

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

// Local midnight of a typed day, `plusDays` later. Null for anything that isn't
// a whole date — Chrome reports a year still being typed ("0002-03-04"), and
// `new Date(2, …)` would read it as 1902.
function localMidnight(ymd: string, plusDays = 0): Date | null {
  const m = YMD.exec(ymd);
  if (!m) return null;
  const year = Number(m[1]);
  if (year < 1000) return null;
  const d = new Date(2000, 0, 1);
  d.setFullYear(year, Number(m[2]) - 1, Number(m[3]) + plusDays);
  d.setHours(0, 0, 0, 0);
  return isNaN(d.getTime()) ? null : d;
}

/** The `dateFrom` param for a typed day: "" clears it, null means "not a date yet" (leave the URL alone). */
export function dateFromParam(ymd: string): string | null {
  if (ymd === "") return "";
  return localMidnight(ymd)?.toISOString() ?? null;
}

const DAY_MS = 86_400_000;

/**
 * The `dateTo` param for a typed day. The server ends the range one UTC day
 * (24 h) after the instant it gets, so the instant sent is 24 h before the NEXT
 * local midnight: the range then ends exactly where the viewer's day does, on
 * a 23- or 25-hour DST day too (local midnight + 24 h was an hour off there).
 */
export function dateToParam(ymd: string): string | null {
  if (ymd === "") return "";
  const next = localMidnight(ymd, 1);
  return next ? new Date(next.getTime() - DAY_MS).toISOString() : null;
}

/**
 * A date box's value for a URL param: the viewer's local day the instant
 * names. Read at the instant + 12 h — the day whose midnight is nearest — so a
 * `dateTo` sent by dateToParam (an hour before or after local midnight on a DST
 * day) and an older link's plain local midnight both land on their own day. A
 * bare YYYY-MM-DD (an old bookmark) passes through. Depends on the viewer's
 * time zone, so every callsite is mounted-gated (guardrail 16).
 */
export function dateInputValue(param: string): string {
  if (YMD.test(param)) return param;
  const at = new Date(param).getTime();
  if (isNaN(at)) return "";
  const d = new Date(at + DAY_MS / 2);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ── a row's action badge ────────────────────────────────────────────────────

/** An action's chip colour; an unknown code (a newer server) gets the neutral chip. */
export function actionInfo(action: string): { color: string } {
  return { color: ACTION_COLORS[action as AuditAction] ?? "bg-zinc-800 text-zinc-400" };
}
