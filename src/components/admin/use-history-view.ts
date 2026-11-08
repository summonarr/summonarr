"use client";

// Admin → Download History's view (arr-download-history.tsx renders it): the
// tab, instance, kind filter and page on screen, the rows drawn for them, the
// Blocklist tab's count, the blocklist selection, and the one load that reads
// the view live.
//
// - ONE builder for every read (arr-history-view.ts): the live load fetches
//   `viewUrl` and the "instant, then live" snapshot is read for that same
//   string. A snapshot is drawn exactly as a live answer is — the rows, and
//   the kind the History rows were read with — and nothing else, and never
//   while a write is in flight (`writing`, read live) nor for the page a live
//   load just jumped to (paintsSnapshot). markLive() runs only for an accepted
//   live answer.
// - Every load runs under one key: a newer one aborts the one before, so an
//   older answer can never land over the view on screen. A page past the end
//   (its records removed, or a URL naming a page the list no longer has) jumps
//   to the last page, and the load that follows keeps the error a write left.
// - `reload` always loads the view on screen NOW: a write's re-read, and a
//   removal heard from the title manager, can never draw another view's rows.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useArrSnapshot } from "@/components/admin/use-arr-snapshot";
import { arrInstanceKey, useTRef } from "@/components/admin/arr-title/shared";
import { withBasePath } from "@/lib/base-path";
import { lastPageIfStranded, type ArrHistoryEvent, type ArrPage, type BlocklistEntry, type HistoryFilterKind } from "@/lib/arr-history";
import { blocklistCountPath, historyViewPath, paintsSnapshot, type HistoryView } from "@/lib/arr-history-view";
import { arrCall } from "@/lib/client/arr-call";
import { BLOCKLIST_PAGE, HISTORY_PAGE } from "@/lib/client/arr-answers";
import { check, type Schema } from "@/lib/validate";
import { useAsyncAction } from "@/hooks/use-async-action";

export type Service = "radarr" | "sonarr";
export type Tab = "history" | "blocklist";
export interface InstanceRef { service: Service; slug: string; name: string }

export const PAGE_SIZE = 50;
// A blocklist entry's identity: its id alone collides across instances.
export const entryKey = (r: BlocklistEntry) => `${r.service}:${r.instance}:${r.id}`;

export function useHistoryView({ instances, initialTab, initialInstance, initialKind, initialPage, writing }: {
  instances: InstanceRef[];
  initialTab: Tab;
  initialInstance: string | null;
  initialKind: HistoryFilterKind | null;
  initialPage: number;
  /** A write the admin started is in flight, or Clear's command is still followed (read when a snapshot answers). */
  writing: () => boolean;
}) {
  const tRef = useTRef();
  const [tab, setTab] = useState<Tab>(initialTab);
  const [current, setCurrent] = useState<string>(
    instances.some((i) => arrInstanceKey(i) === initialInstance) ? (initialInstance as string) : instances[0] ? arrInstanceKey(instances[0]) : "",
  );
  const inst = instances.find((i) => arrInstanceKey(i) === current) ?? null;
  const [kind, setKind] = useState<HistoryFilterKind | "all">(initialKind ?? "all");
  const [page, setPage] = useState(initialPage);
  const [history, setHistory] = useState<ArrPage<ArrHistoryEvent> | null>(null);
  // The kind filter `history` was READ with — the one in `kind` may still be loading.
  const [historyKind, setHistoryKind] = useState<HistoryFilterKind | "all">("all");
  const [blocklist, setBlocklist] = useState<ArrPage<BlocklistEntry> | null>(null);
  // The Blocklist tab's count before the tab is visited: a pageSize=1 read —
  // or, once the tab has been read, that page's own total.
  const [blocklistCount, setBlocklistCount] = useState<{ inst: string; total: number } | null>(null);
  const [selected, setSelected] = useState<ReadonlyMap<string, BlocklistEntry>>(new Map());
  const [error, setError] = useState("");
  // The view's load ("load") and the count's ("count").
  const reads = useAsyncAction();
  const loading = reads.busy("load");
  // Set when a load jumps to the last page: the load that follows continues it.
  const keepErrorNext = useRef(false);
  // The read a load just jumped to (the page asked for was past the end): its
  // snapshot predates what that answer showed, so only a live answer draws it.
  const jumpedTo = useRef<string | null>(null);

  // The view on screen and the one read it is drawn from — fetched live by
  // `load`, and the snapshot's key — or null with nothing to read.
  const view = useMemo<HistoryView | null>(
    () => (inst ? { tab, service: inst.service, instance: inst.slug, page, pageSize: PAGE_SIZE, kind } : null),
    [inst, tab, page, kind],
  );
  const viewUrl = useMemo(() => (view ? withBasePath(historyViewPath(view)) : null), [view]);
  const countUrl = useMemo(() => (inst ? withBasePath(blocklistCountPath(inst.service, inst.slug)) : null), [inst]);

  // Which read the last snapshot offered was actually drawn for: the stale note
  // describes the rows on screen, never a snapshot paintsSnapshot turned away.
  const [snapshotDrawn, setSnapshotDrawn] = useState<string | null>(null);
  const { staleAt, markLive } = useArrSnapshot<unknown>(viewUrl, (data) => {
    // A checked page of the view's tab, drawn as its live answer would be.
    const offer = <T,>(schema: Schema<ArrPage<T>>, draw: (page: ArrPage<T>) => void): boolean => {
      const parsed = check(schema, data);
      const ok = view !== null && parsed.ok && paintsSnapshot({
        writing: writing(),
        jumpedHere: jumpedTo.current === viewUrl,
        page: view.page,
        data: parsed.value,
      });
      setSnapshotDrawn(ok ? viewUrl : null);
      if (!ok || !parsed.ok) return false;
      draw(parsed.value);
      return true;
    };
    if (view === null) return false;
    return view.tab === "history"
      ? offer(HISTORY_PAGE, (page) => {
        setHistory(page);
        setHistoryKind(view.kind);
      })
      : offer(BLOCKLIST_PAGE, (page) => setBlocklist(page));
  });
  // The Blocklist tab's count, drawn from its own snapshot until it is read live.
  const { markLive: markCountLive } = useArrSnapshot<unknown>(countUrl, (data) => {
    const page = check(BLOCKLIST_PAGE, data);
    if (!inst || !page.ok) return false;
    setBlocklistCount({ inst: arrInstanceKey(inst), total: page.value.totalRecords });
    return true;
  });

  const load = useCallback(async (opts: { keepError?: boolean } = {}) => {
    if (!view || !viewUrl) return;
    const keepError = opts.keepError === true || keepErrorNext.current;
    keepErrorNext.current = false;
    if (!keepError) setError("");
    // One read for either tab; only what an accepted page draws differs.
    async function readPage<T>(schema: Schema<ArrPage<T>>, fallbackKey: string, draw: (data: ArrPage<T>) => void) {
      if (!view || !viewUrl) return;
      const res = await reads.run("load", (signal) => arrCall(viewUrl, { schema, signal, fallback: tRef.current(fallbackKey) }));
      // Superseded by a newer load, or the page left.
      if (!res) return;
      if (!res.ok) {
        setError(res.error);
        return;
      }
      // Past the end (its records were removed, or the URL named a page the
      // list no longer has): show the last page instead — the effect loads it.
      const last = lastPageIfStranded(view.page, res.data);
      if (last !== null) {
        keepErrorNext.current = true;
        jumpedTo.current = withBasePath(historyViewPath({ ...view, page: last }));
        setPage(last);
        return;
      }
      draw(res.data);
      jumpedTo.current = null;
      markLive();
    }
    if (view.tab === "history") {
      await readPage(HISTORY_PAGE, "adminArr.history.loadFailed", (data) => {
        setHistory(data);
        setHistoryKind(view.kind);
      });
    } else {
      await readPage(BLOCKLIST_PAGE, "adminArr.blocklist.loadFailed", (data) => {
        const keys = new Set(data.records.map(entryKey));
        setBlocklist(data);
        // Kept as the tab's count too, so the badge holds it back on History.
        setBlocklistCount({ inst: arrInstanceKey({ service: view.service, slug: view.instance }), total: data.totalRecords });
        // Only rows on screen stay selected.
        setSelected((prev) => new Map([...prev].filter(([k]) => keys.has(k))));
      });
    }
  }, [view, viewUrl, reads, tRef, markLive]);

  // The loader of the view on screen now, for reloads that finish after a click.
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);
  const reload = useCallback((opts?: { keepError?: boolean }) => loadRef.current(opts), []);

  useEffect(() => {
    void load();
  }, [load]);

  // The tab on screen, for the count read (which must not re-run on a tab switch).
  const tabRef = useRef<Tab>(tab);
  useEffect(() => {
    tabRef.current = tab;
  }, [tab]);
  useEffect(() => {
    if (!inst || !countUrl) return;
    // On the Blocklist tab its own page read carries the total: no second read.
    if (tabRef.current === "blocklist") return;
    const key = arrInstanceKey(inst);
    void reads.run("count", (signal) => arrCall(countUrl, { schema: BLOCKLIST_PAGE, signal, fallback: "" })).then((res) => {
      if (res?.ok) {
        setBlocklistCount({ inst: key, total: res.data.totalRecords });
        markCountLive();
      }
    });
    return () => reads.abort("count");
  }, [inst, countUrl, reads, markCountLive]);

  return {
    tab,
    current,
    inst,
    kind,
    page,
    setPage,
    /** Another tab, from its first page. */
    showTab(next: Tab) {
      setTab(next);
      setPage(1);
    },
    /** Another instance, from the first page, with nothing of the last one's on screen. */
    showInstance(next: string) {
      setCurrent(next);
      setPage(1);
      setHistory(null);
      setBlocklist(null);
      setSelected(new Map());
    },
    /** Another kind filter, from the first page. */
    showKind(next: HistoryFilterKind | "all") {
      setKind(next);
      setPage(1);
    },
    history,
    historyKind,
    blocklist,
    blocklistTotal: blocklist?.totalRecords ?? (blocklistCount?.inst === current ? blocklistCount.total : undefined),
    selected, setSelected,
    error, setError,
    loading,
    /** When the rows on screen were read, while they are a snapshot. */
    staleAt: snapshotDrawn === viewUrl ? staleAt : null,
    load,
    reload,
  };
}
