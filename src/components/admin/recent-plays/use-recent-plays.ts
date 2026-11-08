"use client";

// The Recent plays card's list: page 1 from the server, further pages from
// /api/play-history on "Load more", and the server's fresh page 1 merged in on
// a live refresh. Loads go through fetchJson (timeout, shape check) under
// useAsyncAction, so a second click doesn't double-load and an unmount drops
// a late answer.

import { useEffect, useState } from "react";
import { withBasePath } from "@/lib/base-path";
import { fetchJson } from "@/lib/client/fetch-json";
import { RECENT_PLAYS_PAGE_SIZE } from "@/lib/activity-constants";
import { useAsyncAction } from "@/hooks/use-async-action";
import { historyPageSchema } from "@/components/admin/activity-history/schema";
import { appendPlays, mergeRefreshedPlays, toRecentPlay, type RecentPlay } from "./map";

export interface RecentPlaysState {
  plays: RecentPlay[];
  hasMore: boolean;
  loading: boolean;
  loadError: boolean;
  loadMore: () => Promise<void>;
}

export function useRecentPlays({
  initialPlays,
  source,
  mediaType,
  startDateIso,
  unknownUser,
}: {
  initialPlays: RecentPlay[];
  source?: string;
  mediaType?: string;
  startDateIso?: string;
  unknownUser: string;
}): RecentPlaysState {
  const loader = useAsyncAction();
  const [plays, setPlays] = useState<RecentPlay[]>(initialPlays);
  const [hasMore, setHasMore] = useState(initialPlays.length >= RECENT_PLAYS_PAGE_SIZE);
  const [page, setPage] = useState(1);
  const [loadError, setLoadError] = useState(false);

  // When a stream finishes, ActivityLiveRefresher calls router.refresh(). That
  // sends new props but keeps this component (and its useState) alive, so we
  // copy the fresh `plays` prop into state here. Same pattern as
  // browse-grid.tsx and audit-log-table.tsx. On page 1 the fresh page replaces
  // the list; past it the new plays are merged in (mergeRefreshedPlays), and
  // page and hasMore stay as they are: a later page that repeats a row is
  // deduped there.
  useEffect(() => {
    if (page === 1) {
      setPlays(initialPlays);
      setHasMore(initialPlays.length >= RECENT_PLAYS_PAGE_SIZE);
      return;
    }
    setPlays((prev) => mergeRefreshedPlays(prev, initialPlays));
  }, [initialPlays, page]);

  async function loadMore() {
    setLoadError(false);
    const nextPage = page + 1;
    const filterParams = new URLSearchParams();
    filterParams.set("page", String(nextPage));
    filterParams.set("limit", String(RECENT_PLAYS_PAGE_SIZE));
    // Page 1 came from the server as RECENT_PLAYS_PAGE_SIZE plain PlayHistory
    // rows. The API normally groups related rows (referenceId chains)
    // together, which would make "page 2" start at the wrong place and skip
    // rows, so ask for ungrouped rows to match page 1.
    filterParams.set("ungrouped", "true");
    if (source) filterParams.set("source", source);
    if (mediaType) filterParams.set("mediaType", mediaType);
    if (startDateIso) filterParams.set("startDate", startDateIso);
    const res = await loader.run(
      "more",
      (signal) =>
        fetchJson(withBasePath(`/api/play-history?${filterParams.toString()}`), { schema: historyPageSchema, signal }),
      { ifBusy: "skip" },
    );
    if (!res) return;
    if (!res.ok) {
      if (res.kind === "aborted") return;
      console.error(`[activity-recent-plays] load more failed (${res.kind}, ${res.status}): ${res.detail}`);
      setLoadError(true);
      return;
    }
    const items = res.data.items.map((p) => toRecentPlay(p, unknownUser));
    setPlays((prev) => appendPlays(prev, items));
    setPage(nextPage);
    setHasMore(items.length >= RECENT_PLAYS_PAGE_SIZE);
  }

  return { plays, hasMore, loading: loader.busy("more"), loadError, loadMore };
}
