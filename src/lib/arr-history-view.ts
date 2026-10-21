// The reads behind Admin → Download History
// (src/components/admin/arr-download-history.tsx), built in ONE place: the
// page's live load fetches exactly this URL and its "instant, then live"
// snapshot (src/lib/arr-snapshot.ts) is read for it, so the two can never name
// different reads — the server keys a snapshot on path + query, and another
// spelling would paint another page's rows, or never find one. Pure: the page
// is a .tsx the unit loader can't import.
import { lastPageIfStranded, type HistoryFilterKind } from "@/lib/arr-history";

export interface HistoryView {
  tab: "history" | "blocklist";
  service: "radarr" | "sonarr";
  instance: string;
  page: number;
  pageSize: number;
  /** The History tab's kind filter; the Blocklist tab has none. */
  kind: HistoryFilterKind | "all";
}

/** The GET the view on screen is drawn from (no base path). */
export function historyViewPath(v: HistoryView): string {
  const q = new URLSearchParams({ service: v.service, instance: v.instance, page: String(v.page), pageSize: String(v.pageSize) });
  if (v.tab === "history") {
    if (v.kind !== "all") q.set("kind", v.kind);
    return `/api/admin/arr/history?${q.toString()}`;
  }
  return `/api/admin/arr/blocklist?${q.toString()}`;
}

/** The Blocklist tab's count before the tab is visited: a one-record read. */
export function blocklistCountPath(service: HistoryView["service"], instance: string): string {
  return historyViewPath({ tab: "blocklist", service, instance, page: 1, pageSize: 1, kind: "all" });
}

/**
 * Whether a snapshot may be drawn over the view now. Never while a write the
 * admin started is in flight (a Mark failed, a removal, a clear — or Clear
 * blocklist's command still being followed): new rows would land under that
 * write's pending or refused state. Never for a page the live load just JUMPED
 * to because the one asked for was past the end: that answer proved the list
 * shrank (a removal emptied the last page), so the snapshot of the page it
 * lands on predates the write — the post-write re-read draws it. And never a
 * snapshot that is itself past the end: only a live answer moves the page.
 */
export function paintsSnapshot(s: {
  writing: boolean;
  jumpedHere: boolean;
  page: number;
  data: { records: readonly unknown[]; totalRecords: number; pageSize: number };
}): boolean {
  return !s.writing && !s.jumpedHere && lastPageIfStranded(s.page, s.data) === null;
}
