import type { AuditAction, Prisma } from "@/generated/prisma";
import { AUDIT_ACTIONS, ACTION_GROUP, type AuditGroup } from "./audit-actions";
import { sanitizeContainsSearch } from "./sanitize";

// The audit-log filter, built ONCE for its three readers: the admin page's
// first page, the list API's "Load more" (GET /api/admin/audit-log) and the
// CSV/JSON export. The table forwards the same filter state to all three, so a
// copy that drifts shows one set of rows and loads or exports another — the
// page used to drop an unparseable date and render UNFILTERED rows while "Load
// more" and the export of the identical view answered 400.

// Coarse group filter — derived from the shared ACTION_GROUP so the schema enum
// is the single source of truth. Adding a new enum value with a group assignment
// in audit-actions.ts automatically populates the right bucket here.
export const AUDIT_GROUP_ACTIONS: Record<AuditGroup, AuditAction[]> = {
  auth: [],
  admin: [],
  system: [],
};
for (const action of AUDIT_ACTIONS) {
  AUDIT_GROUP_ACTIONS[ACTION_GROUP[action]].push(action);
}

// The filter as applied. `action` is null when absent OR not an AuditAction (an
// unknown action is ignored, not matched against nothing); the strings are the
// values as sent, so a caller can hand them back to the client unchanged.
export interface AuditLogFilters {
  action: AuditAction | null;
  group: AuditGroup | null;
  dateFrom: string | null;
  dateTo: string | null;
  user: string | null;
  target: string | null;
  hideCron: boolean;
}

export type AuditLogFilterResult =
  | { error?: undefined; where: Prisma.AuditLogWhereInput; filters: AuditLogFilters }
  | { error: "invalidDateFrom" | "invalidDateTo"; param: "dateFrom" | "dateTo" };

// `params` is a URLSearchParams (or anything with its `get`): a repeated key
// reads as its FIRST value, on the page exactly as in the routes.
export function buildAuditLogWhere(params: { get(name: string): string | null }): AuditLogFilterResult {
  const actionParam = params.get("action");
  const action = actionParam && (AUDIT_ACTIONS as string[]).includes(actionParam) ? (actionParam as AuditAction) : null;
  const groupParam = params.get("group");
  const group: AuditGroup | null =
    groupParam === "auth" || groupParam === "admin" || groupParam === "system" ? groupParam : null;
  const dateFrom = params.get("dateFrom") || null;
  const dateTo = params.get("dateTo") || null;
  const user = params.get("user") || null;
  const target = params.get("target") || null;
  const hideCron = params.get("hideCron") === "1";

  const where: Prisma.AuditLogWhereInput = {};

  // Action is more specific than group — action wins if both are present
  if (action) where.action = action;
  else if (group) where.action = { in: AUDIT_GROUP_ACTIONS[group] };

  if (dateFrom || dateTo) {
    where.createdAt = {};
    // Both bounds arrive as ISO instants — the START of the viewer's LOCAL
    // calendar day (the filter bar converts the date input's YYYY-MM-DD with
    // `new Date(y, m - 1, d)`), so the filter cuts where the Timeline view's
    // day headings do. A bare YYYY-MM-DD from an old bookmark still parses (as
    // UTC midnight). An invalid date is an error for every reader, never a
    // silently dropped bound: in the export it would otherwise throw inside
    // the stream after the headers went out (a half-written file, and the
    // paper-trail row left unfinished).
    if (dateFrom) {
      const start = new Date(dateFrom);
      if (isNaN(start.getTime())) return { error: "invalidDateFrom", param: "dateFrom" };
      where.createdAt.gte = start;
    }
    if (dateTo) {
      const end = new Date(dateTo);
      if (isNaN(end.getTime())) return { error: "invalidDateTo", param: "dateTo" };
      // Advance by one UTC day to make the range inclusive of the requested end
      // date: exactly 24h past the local-day start the client sent. UTC,
      // because local-time setDate lands 23/25 h later across a DST change in
      // a non-UTC TZ.
      end.setUTCDate(end.getUTCDate() + 1);
      where.createdAt.lt = end;
    }
  }

  // Prisma `contains` → ILIKE with no ESCAPE clause; strip wildcard
  // metacharacters and bound the length (search-box DoS, matches /api/votes).
  if (user) where.userName = { contains: sanitizeContainsSearch(user), mode: "insensitive" };
  if (target) where.target = { contains: sanitizeContainsSearch(target), mode: "insensitive" };

  if (hideCron) {
    // "Hide cron" means hide the SYSTEM principal, not hide every row without a
    // user. `{ not: "system" }` compiles to `"userId" <> 'system'`, and in SQL
    // NULL <> 'system' is NULL, not TRUE — so Postgres drops every NULL-userId row
    // too. Three writers produce those, and the one that matters is
    // /api/auth/machine-session, which mints an ADMIN-impersonating JWT from
    // CRON_SECRET and is deliberately attributed to the machine rather than to the
    // assumed admin. That row is the only record the mint happened, and ticking a
    // filter labelled "Showing only real users" silently removed it — including
    // from the CSV/JSON export.
    where.AND = [{ OR: [{ userId: null }, { userId: { not: "system" } }] }];
  }

  return { where, filters: { action, group, dateFrom, dateTo, user, target, hideCron } };
}
