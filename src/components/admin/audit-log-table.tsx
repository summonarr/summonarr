"use client";

// Audit-log viewer: the filter bar (audit-log-filters.tsx) over the rows
// (audit-log-rows.tsx, as a table or a timeline), with "Load more" appending
// cursor pages to the server-rendered first page. The pure halves are
// src/lib/audit-log-client.ts.

import { useState, useEffect, useRef } from "react";
import { EmptyState } from "@/components/ui/design";
import { List, X } from "@/components/icons";
import { useHasMounted } from "@/hooks/use-has-mounted";
import { useAsyncAction } from "@/hooks/use-async-action";
import { withBasePath } from "@/lib/base-path";
import { fetchJson } from "@/lib/client/fetch-json";
import { useT } from "@/components/i18n/i18n-provider";
import { AUDIT_VIEW_COOKIE, type AuditViewMode } from "@/lib/audit-log-view";
import {
  AuditPageSchema, CLEAR_ALL_FILTERS, filtersToParams, hasAnyFilter,
  type AuditFilters, type AuditPage, type AuditRow,
} from "@/lib/audit-log-client";
import { AuditLogFilters, useAuditNav } from "@/components/admin/audit-log-filters";
import { AuditLogTable, AuditLogTimeline } from "@/components/admin/audit-log-rows";

export type { AuditFilters } from "@/lib/audit-log-client";

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

// One page of the list route for these filters, checked.
function fetchAuditPage(filters: AuditFilters, cursor: string | null, signal: AbortSignal) {
  const params = filtersToParams(filters);
  if (cursor) params.set("cursor", cursor);
  return fetchJson(withBasePath(`/api/admin/audit-log?${params.toString()}`), { schema: AuditPageSchema, signal });
}

// The list route's page size (and the server page's).
const PAGE_SIZE = 50;

// Reads the first `count` rows again (whole pages). A page that fails ends the
// read with what came back fresh; null when not even the first page did.
async function rereadRows(filters: AuditFilters, count: number, signal: AbortSignal): Promise<AuditPage | null> {
  const logs: AuditRow[] = [];
  let cursor: string | null = null;
  let hasMore = false;
  for (let pages = 0; pages < Math.ceil(count / PAGE_SIZE) || pages === 0; pages++) {
    const res = await fetchAuditPage(filters, cursor, signal);
    if (!res.ok) return logs.length > 0 ? { logs, nextCursor: cursor, hasMore: true } : null;
    for (const row of res.data.logs) logs.push(row);
    cursor = res.data.nextCursor;
    hasMore = res.data.hasMore;
    if (!hasMore) break;
  }
  return { logs, nextCursor: cursor, hasMore };
}

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
  const [viewMode, setViewMode] = useState<AuditViewMode>(initialViewMode ?? "table");
  // Bumped by each finished PII scrub: the list re-reads the rows it shows.
  const [scrubs, setScrubs] = useState(0);

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

  function handleViewModeChange(mode: AuditViewMode) {
    setViewMode(mode);
    saveViewMode(mode);
  }

  // A filter change brings a new server page: the list starts over from it
  // (a fresh mount — its state, a load in flight and any load-more error go
  // with the old one). A re-render with the same filters and the same newest
  // row keeps the pages already loaded, and the scroll with them.
  const listKey = `${filtersToParams(filters).toString()}|${initialLogs[0]?.id ?? ""}`;

  return (
    <div className="space-y-4">
      <AuditLogFilters
        filters={filters}
        viewMode={viewMode}
        onViewModeChange={handleViewModeChange}
        onScrubbed={() => setScrubs((n) => n + 1)}
      />

      <AuditLogList
        key={listKey}
        initialLogs={initialLogs}
        initialNextCursor={initialNextCursor}
        initialHasMore={initialHasMore}
        filters={filters}
        viewMode={viewMode}
        scrubs={scrubs}
        redactedUserName={redactedUserName}
      />
    </div>
  );
}

// The rows of one filter result: the server's first page, then "Load more".
function AuditLogList({
  initialLogs,
  initialNextCursor,
  initialHasMore,
  filters,
  viewMode,
  scrubs,
  redactedUserName,
}: {
  initialLogs: AuditRow[];
  initialNextCursor: string | null;
  initialHasMore: boolean;
  filters: AuditFilters;
  viewMode: AuditViewMode;
  scrubs: number;
  redactedUserName: string;
}) {
  const t = useT();
  const navigate = useAuditNav();
  const mounted = useHasMounted();
  const reads = useAsyncAction();
  const hasFilters = hasAnyFilter(filters);
  const [logs, setLogs] = useState(initialLogs);
  const [nextCursor, setNextCursor] = useState(initialNextCursor);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [loadError, setLoadError] = useState(false);
  const loading = reads.busy("more") || reads.busy("reread");

  // After a scrub the rows on screen still show the IPs, user agents and names
  // it removed: read the same rows again (not just the first page, so nothing
  // already loaded — or the scroll — is lost). The count and filters are read
  // when the scrub lands, through a ref updated after each commit.
  const handledScrubs = useRef(scrubs);
  const shown = useRef({ count: logs.length, filters });
  useEffect(() => {
    shown.current = { count: logs.length, filters };
  });
  useEffect(() => {
    if (scrubs === handledScrubs.current) return;
    handledScrubs.current = scrubs;
    const { count, filters: current } = shown.current;
    // A page still loading was asked for with the old cursor: it goes.
    reads.abort("more");
    void reads.run("reread", (signal) => rereadRows(current, count, signal)).then((fresh) => {
      if (fresh === undefined) return;
      if (!fresh) {
        setLoadError(true);
        return;
      }
      setLogs(fresh.logs);
      setNextCursor(fresh.nextCursor);
      setHasMore(fresh.hasMore);
      setLoadError(false);
    });
  }, [scrubs, reads]);

  async function loadMore() {
    if (!nextCursor || loading) return;
    setLoadError(false);
    // Superseded only by this list's unmount: a new filter result is a new list.
    const res = await reads.run("more", (signal) => fetchAuditPage(filters, nextCursor, signal));
    if (!res) return;
    if (!res.ok) {
      setLoadError(true);
      return;
    }
    const page = res.data;
    setLogs((prev) => [...prev, ...page.logs]);
    setNextCursor(page.nextCursor);
    setHasMore(page.hasMore);
  }

  return (
    <>
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
    </>
  );
}
