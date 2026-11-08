"use client";

// Admin → Download Queue's filters (download-queue.tsx): the tab, the instance
// picker, the title text and the exact-title filter a link can set, kept in
// step with the page's link. The pure halves are queue-filters.ts.

import { useMemo, useState } from "react";
import type { QueueItem } from "@/lib/arr-queue";
import { matchesQueueTitle, queueLinkKey, type QueueLinkFilters, type QueueTitleFilter } from "@/lib/arr-manage-links";
import type { QueueReport } from "@/components/admin/use-queue-data";
import { effectiveQueueFilters, filterQueueRows, queueTabCounts, type QueueFilter } from "@/components/admin/queue-filters";

export function useQueueFilters(
  initialFilters: QueueLinkFilters,
  report: QueueReport | null,
  /** A new link replaced the filters: the page closes what the link was clicked in. */
  onNewLink: () => void,
) {
  const [filter, setFilter] = useState<QueueFilter>(initialFilters.filter ?? "all");
  const [instance, setInstance] = useState("all");
  const [query, setQuery] = useState(initialFilters.q);
  const [titleFilter, setTitleFilter] = useState<QueueTitleFilter | null>(initialFilters.title);
  // Following a link to this page while on it (a title manager's "See its
  // downloads in the queue") re-renders the server page, which hands over a NEW
  // filters object. When it asks for other filters than the URL holds now
  // (`linked` — clearTitleFilter edits the URL without a server render), they
  // replace the ones on screen and close the manager the link was clicked in
  // (adjust-state-during-render). A re-render of the same URL (router.refresh)
  // asks for the same filters and leaves the admin's alone.
  const [seenFilters, setSeenFilters] = useState(initialFilters);
  const [linked, setLinked] = useState(() => queueLinkKey(initialFilters));
  if (seenFilters !== initialFilters) {
    setSeenFilters(initialFilters);
    const incoming = queueLinkKey(initialFilters);
    if (incoming !== linked) {
      setLinked(incoming);
      setQuery(initialFilters.q);
      setTitleFilter(initialFilters.title);
      setFilter(initialFilters.filter ?? "all");
      onNewLink();
    }
  }

  // Drop the exact-title filter, and its parameters from the URL so a reload
  // shows the whole queue too (any `q` and `filter` stay). `linked` follows the
  // URL — every part of it, the tab included — so a later link back to the same
  // title applies again, and one to the URL left behind is not taken for new.
  function clearTitleFilter() {
    setTitleFilter(null);
    setLinked(queueLinkKey({ ...initialFilters, title: null }));
    try {
      const sp = new URLSearchParams(window.location.search);
      for (const k of ["service", "instance", "arrId"]) sp.delete(k);
      const qs = sp.toString();
      window.history.replaceState(null, "", qs ? `?${qs}` : window.location.pathname);
    } catch {}
  }

  const items = report?.items;
  const instances = useMemo(() => report?.instances ?? [], [report]);
  // A tab or instance whose control is gone applies nothing (queue-filters.ts).
  const applied = effectiveQueueFilters({ filter, instance }, instances);
  // The exact-title filter applies before the others: it is what the link was for.
  const titleRows: QueueItem[] = useMemo(
    () => (titleFilter ? (items ?? []).filter((r) => matchesQueueTitle(r, titleFilter)) : (items ?? [])),
    [items, titleFilter],
  );
  const visible = useMemo(
    () => filterQueueRows(titleRows, { filter: applied.filter, instance: applied.instance, query }),
    [titleRows, applied.filter, applied.instance, query],
  );
  // Per-tab counts, once per change of the rows (not per keystroke or poll render).
  const counts = useMemo(() => (items ? queueTabCounts(titleRows) : null), [items, titleRows]);

  return {
    filter: applied.filter, setFilter,
    instance: applied.instance, setInstance,
    query, setQuery,
    titleFilter, clearTitleFilter,
    titleRows, visible, counts,
  };
}
