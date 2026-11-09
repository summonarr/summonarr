"use client";

// The /watch-history list's data: the shown page, refetches on a filter change,
// "Load more" and the failure states. Every piece of state is tagged with the
// query it belongs to (`queryKey`), so a slow answer for an old query can never
// land under a new one and nothing has to be cleared by hand on a switch: the
// cursor, the Load more spinner and its error simply stop matching.
import { useEffect, useRef, useState } from "react";
import { withBasePath } from "@/lib/base-path";
import { useAsyncAction } from "@/hooks/use-async-action";
import type { MyWatchHistoryItem, MyWatchHistoryPage } from "@/lib/my-watch-history";
import { fetchHistoryPage, historyQuery } from "./history-page-fetch";

export type TypeFilter = "" | "MOVIE" | "TV";

export function queryKey(type: TypeFilter, search: string, reload: number): string {
  return `${type}|${search.trim()}|${reload}`;
}

type ShownPage = {
  key: string;
  items: MyWatchHistoryItem[];
  total: number;
  nextCursor: string | null;
  /** Load more appended to it: a fresh server page would drop those rows. */
  extended: boolean;
};

export type HistoryFailure = { rateLimited: boolean; retryAfterSeconds: number | null };

function shownFrom(key: string, page: Pick<MyWatchHistoryPage, "items" | "total" | "nextCursor">): ShownPage {
  return { key, items: page.items, total: page.total, nextCursor: page.nextCursor, extended: false };
}

/** Appends a further page, de-duplicated by id: a row can shift into an
 *  already-loaded page as new plays finalize between fetches. */
export function appendPage(cur: readonly MyWatchHistoryItem[], more: readonly MyWatchHistoryItem[]): MyWatchHistoryItem[] {
  const seen = new Set(cur.map((i) => i.id));
  return [...cur, ...more.filter((i) => !seen.has(i.id))];
}

export function useWatchHistory({
  initial,
  initialType,
  initialSearch,
  typeFilter,
  search,
}: {
  /** The server-rendered first page, for `initialType`/`initialSearch`. */
  initial: MyWatchHistoryPage;
  initialType: TypeFilter;
  initialSearch: string;
  typeFilter: TypeFilter;
  /** The debounced search text. */
  search: string;
}) {
  const more = useAsyncAction();
  const [reloadKey, setReloadKey] = useState(0);
  const key = queryKey(typeFilter, search, reloadKey);
  const serverKey = queryKey(initialType, initialSearch, 0);

  const [page, setPage] = useState<ShownPage>(() => shownFrom(serverKey, initial));
  // A new server page (a router.refresh, e.g. after filing an issue) replaces
  // the shown one while it answers the same query and nothing was appended.
  const [seenInitial, setSeenInitial] = useState(initial);
  if (initial !== seenInitial) {
    setSeenInitial(initial);
    if (page.key === serverKey && key === serverKey && !page.extended) setPage(shownFrom(serverKey, initial));
  }

  const [failure, setFailure] = useState<(HistoryFailure & { key: string }) | null>(null);
  const [moreFailure, setMoreFailure] = useState<(HistoryFailure & { key: string }) | null>(null);
  // Retry stays disabled for a 429's named wait: an earlier click only spends
  // another request against the same limit.
  const [retryBlocked, setRetryBlocked] = useState(false);
  const cooldownRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The same wait for a rate-limited Load more.
  const [moreBlocked, setMoreBlocked] = useState(false);
  const moreCooldownRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (cooldownRef.current) clearTimeout(cooldownRef.current);
      if (moreCooldownRef.current) clearTimeout(moreCooldownRef.current);
    },
    [],
  );

  // Refetch page one whenever the shown page answers another query. The first
  // render (and Strict Mode's second effect run) already hold the server's
  // page for the URL's filters, so no request goes out for it.
  useEffect(() => {
    if (page.key === key) return;
    // The previous query's Load more is moot; stop its request.
    more.abort();
    const ac = new AbortController();
    void fetchHistoryPage(withBasePath(`/api/play-history/mine?${historyQuery(typeFilter, search)}`), ac.signal).then(
      (res) => {
        if (res.ok) {
          setPage(shownFrom(key, res.page));
          return;
        }
        if (res.aborted) return;
        setFailure({ key, rateLimited: res.rateLimited, retryAfterSeconds: res.retryAfterSeconds });
        if (res.retryAfterSeconds !== null) {
          setRetryBlocked(true);
          if (cooldownRef.current) clearTimeout(cooldownRef.current);
          cooldownRef.current = setTimeout(() => setRetryBlocked(false), res.retryAfterSeconds * 1000);
        }
      },
    );
    return () => ac.abort();
  }, [key, page.key, typeFilter, search, more]);

  const current = page.key === key;
  const loadFailed = failure?.key === key ? failure : null;
  // The cursor belongs to the shown query only: sending an old query's keyset
  // position into a new filter would skip every row between them for good.
  const nextCursor = current ? page.nextCursor : null;
  const moreKey = `more:${key}`;

  async function loadMore() {
    if (!nextCursor) return;
    const myKey = key;
    setMoreFailure(null);
    const url = withBasePath(`/api/play-history/mine?${historyQuery(typeFilter, search, nextCursor)}`);
    const res = await more.run(moreKey, (signal) => fetchHistoryPage(url, signal), { ifBusy: "skip" });
    if (!res || (!res.ok && res.aborted)) return;
    if (!res.ok) {
      setMoreFailure({ key: myKey, rateLimited: res.rateLimited, retryAfterSeconds: res.retryAfterSeconds });
      if (res.retryAfterSeconds !== null) {
        setMoreBlocked(true);
        if (moreCooldownRef.current) clearTimeout(moreCooldownRef.current);
        moreCooldownRef.current = setTimeout(() => setMoreBlocked(false), res.retryAfterSeconds * 1000);
      }
      return;
    }
    setPage((cur) =>
      cur.key !== myKey
        ? cur
        : { ...cur, items: appendPage(cur.items, res.page.items), total: res.page.total, nextCursor: res.page.nextCursor, extended: true },
    );
  }

  return {
    items: page.items,
    total: page.total,
    nextCursor,
    refreshing: !current && !loadFailed,
    loadFailed,
    retryBlocked,
    retry: () => setReloadKey((k) => k + 1),
    loadMore,
    loadingMore: more.busy(moreKey),
    loadMoreBlocked: moreBlocked,
    loadMoreFailed: moreFailure?.key === key ? moreFailure : null,
  };
}
