"use client";

// Admin → Missing. One tab per service and two modes: MISSING (no file, should
// have one) and CUTOFF UNMET (a file below the quality profile's cutoff —
// Radarr/Sonarr's own /wanted/cutoff). Each (service, mode) loads its report on
// first view (it makes live Radarr/Sonarr calls, so it is never part of the
// server render) and keeps it until Refresh. A Sonarr row expands to its
// episodes — fetched on demand for Missing, already in the listing for Cutoff —
// and every row's Search queues a Radarr/Sonarr search for exactly that title's
// gap (POST /api/admin/missing/search, `mode` picking which). The tables show
// PAGE_SIZE rows at a time; a tick survives a page turn and counts toward the
// bulk cap wherever it is. Every date is a
// server-supplied ISO string formatted for the viewer's locale, and "missing
// for" is a server-computed day count — nothing here reads the clock while
// rendering (guardrail 16).
//
// "Instant, then live" (use-arr-snapshot.ts): until a list holds a live answer,
// the page paints the last one the server kept for the same read — marked with
// when it was read — while the live load is out, then swaps the live answer in.
// A row painted from the snapshot acts through the same routes, which re-judge
// it live. Episode expansion stays live: rows expand independently and the
// hook follows one read per view.

import { Fragment, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { withBasePath } from "@/lib/base-path";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import { posterUrl } from "@/lib/tmdb-types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StyledSelect } from "@/components/ui/styled-select";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogBackdrop, DialogClose, DialogPopup, DialogPortal, DialogTitle } from "@/components/ui/dialog";
import { Chip, EmptyState, FilterBar, StatCard } from "@/components/ui/design";
import { Poster } from "@/components/admin/activity-ui";
import { OpenInArrLink, arrInstanceLabel } from "@/components/admin/open-in-arr";
import { ManageTitleButton } from "@/components/admin/arr-title/title-manager";
import { useArrSnapshot } from "@/components/admin/use-arr-snapshot";
import { ArrSnapshotNote } from "@/components/admin/arr-snapshot-note";
import { manageTabFor } from "@/lib/arr-manage-links";
import { Check, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, CircleDashed, Loader2, RefreshCw, RotateCcw, Search, X } from "@/components/icons";
import type { CutoffMovie, CutoffSeries, MissingEpisode, MissingMovie, MissingSeries } from "@/lib/arr-missing";
import { ARR_ERROR_KIND_KEYS, isArrErrorKind, type ArrErrorKind } from "@/lib/arr-error-kind";
import {
  BULK_SEARCH_CONFIRM_OVER,
  BULK_SEARCH_MAX,
  capSelection,
  runBulkSearch,
  searchAttemptFromResponse,
  type SearchAttempt,
  type SearchOutcome,
} from "@/lib/bulk-search-run";

type Service = "sonarr" | "radarr";
type Mode = "missing" | "cutoff";
type ReportKey = `${Service}:${Mode}`;

type Report<T> = {
  service: Service;
  enabled: boolean;
  instances: Array<{ slug: string; name: string }>;
  // `kind` is what the page shows (translated); `error` is the raw upstream detail.
  errors: Array<{ instance: string; error: string; kind?: ArrErrorKind }>;
  items: T[];
  // Cutoff only: instances whose listing ran past the server's page ceiling.
  truncated?: Array<{ instance: string; read: number; total: number }>;
};
type Reports = {
  "sonarr:missing"?: Report<MissingSeries>;
  "radarr:missing"?: Report<MissingMovie>;
  "sonarr:cutoff"?: Report<CutoffSeries>;
  "radarr:cutoff"?: Report<CutoffMovie>;
};
type EpisodeState = { loading: boolean; error: string; episodes: MissingEpisode[] };
// `outcome` null while a request is in flight (or before any); `message` is the
// route's own text — the error for "failed", the 409's reason for "already".
type SearchState = { busy: boolean; outcome: SearchOutcome | null; message: string };
type BulkRow = { instance: string; arrId: number; title: string; monitored?: boolean };
type BulkResult = {
  key: ReportKey;
  started: number;
  already: number;
  /** Row keys (`${reportKey}|${instance}:${arrId}`) — what "Retry failed" re-selects. */
  failed: string[];
  skipped: number;
  notRun: number;
  total: number;
  cancelled: boolean;
};

type MovieSort = "recent" | "oldest" | "title";
type SeriesSort = "recent" | "most" | "title";

const SERVICE_LABEL: Record<Service, string> = { sonarr: "Sonarr", radarr: "Radarr" };
// Rows rendered per page. A cutoff listing can be library-sized (Radarr's is a
// row per movie), and every row carries a poster, links and a title manager —
// the whole list re-rendered on each keystroke and each bulk-run settle.
const PAGE_SIZE = 100;
const SONARR_STATUSES = new Set(["continuing", "ended", "upcoming", "deleted"]);
const rowKey = (r: { instance: string; arrId: number }) => `${r.instance}:${r.arrId}`;
// A list's live read. ONE builder for the live load and the snapshot read, so
// the server keys the snapshot on exactly the read the live load makes.
const missingListUrl = (svc: Service, m: Mode) => withBasePath(`/api/admin/missing?service=${svc}&mode=${m}`);
const episodeCode = (e: { seasonNumber: number; episodeNumber: number }) =>
  `S${String(e.seasonNumber).padStart(2, "0")}E${String(e.episodeNumber).padStart(2, "0")}`;

// Server-supplied ISO timestamp → the viewer's locale. UTC so a release date
// is the day Radarr/Sonarr recorded, not shifted by the viewer's offset.
function dayFormatter(locale: string) {
  const fmt = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" });
  return (iso: string | null) => (iso ? fmt.format(new Date(iso)) : "—");
}

async function readError(res: Response, fallback: string): Promise<string> {
  const d = (await res.json().catch(() => null)) as { error?: string } | null;
  return d?.error ?? fallback;
}

type Filters = { showUnmonitored: boolean; instance: string; query: string };
function applyFilters<T extends { title: string; instance: string; monitored?: boolean }>(rows: readonly T[], f: Filters): T[] {
  const q = f.query.trim().toLowerCase();
  return rows.filter((r) =>
    (f.showUnmonitored || r.monitored !== false) &&
    (f.instance === "all" || r.instance === f.instance) &&
    (!q || r.title.toLowerCase().includes(q)),
  );
}

const th: React.CSSProperties = { padding: "8px 10px" };
const td: React.CSSProperties = { padding: "6px 10px" };

export function MissingReport({
  initialService,
  initialMode,
  configured,
}: {
  initialService: Service;
  initialMode: Mode;
  configured: Record<Service, boolean>;
}) {
  const t = useT();
  const locale = useLocale();
  const day = useMemo(() => dayFormatter(locale), [locale]);
  const [service, setService] = useState<Service>(initialService);
  const [mode, setMode] = useState<Mode>(initialMode);
  const [reports, setReports] = useState<Reports>({});
  // Every list with a load in flight — per key, so a load of one list can't
  // hide another's: a single slot let a tab switch overwrite it, and the
  // "not while this list is reloading" guards then read false mid-load.
  const [loadingKeys, setLoadingKeys] = useState<ReadonlySet<ReportKey>>(new Set());
  // The newest load of each list: only that one may commit (an older listing
  // landing late never overwrites a newer one, nor clears its loading mark).
  const loadSeq = useRef<Partial<Record<ReportKey, number>>>({});
  const [errors, setErrors] = useState<Partial<Record<ReportKey, string>>>({});
  const [query, setQuery] = useState("");
  const [instance, setInstance] = useState("all");
  const [showUnmonitored, setShowUnmonitored] = useState(false);
  const [movieSort, setMovieSort] = useState<MovieSort>("recent");
  const [seriesSort, setSeriesSort] = useState<SeriesSort>("recent");
  // The filters read the query a beat behind the input, so typing stays
  // responsive over a long listing.
  const deferredQuery = useDeferredValue(query);
  // The page on screen, for the view (list, filters, order) it was turned in —
  // any other view starts again at its first page.
  const [pageView, setPageView] = useState<{ view: string; page: number }>({ view: "", page: 0 });
  // Keyed `${reportKey}|${instance}:${arrId}` — the two modes list the same series.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [episodes, setEpisodes] = useState<Record<string, EpisodeState>>({});
  // Keyed `${reportKey}|${instance}:${arrId}` — a Radarr and a Sonarr row can
  // share an instance slug and an arr id, and so can the two modes.
  const [searches, setSearches] = useState<Record<string, SearchState>>({});
  // Mirrors `searches`, written in the same step: the bulk runner reads a row's
  // state when it DEQUEUES the row, not from the render the run started in, so
  // a row a per-row click made busy (or already searched) is skipped.
  const searchesRef = useRef<Record<string, SearchState>>({});
  const updateSearches = useCallback((fn: (s: Record<string, SearchState>) => Record<string, SearchState>) => {
    searchesRef.current = fn(searchesRef.current);
    setSearches(searchesRef.current);
  }, []);
  // Rows ticked for "Search selected", keyed like `searches`.
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [bulk, setBulk] = useState<{ key: ReportKey; done: number; total: number; cancelling: boolean } | null>(null);
  // Rows a running bulk search still has to take: their own Search is disabled
  // so a click can't search one the run is about to.
  const [bulkPending, setBulkPending] = useState<ReadonlySet<string>>(new Set());
  const [bulkResult, setBulkResult] = useState<BulkResult | null>(null);
  const [confirming, setConfirming] = useState<{ key: ReportKey; count: number; unmonitored: number } | null>(null);
  // The running bulk search. Aborted by Cancel and when the page unmounts —
  // without that the loop kept POSTing after the admin navigated away.
  const bulkAbort = useRef<AbortController | null>(null);
  useEffect(() => () => bulkAbort.current?.abort(), []);

  const current: ReportKey = `${service}:${mode}`;
  // The lists holding a LIVE answer (not a snapshot): the ref for the
  // synchronous checks in `load` and the snapshot painter, the state for the
  // render (the snapshot url). Never shrinks — a Refresh is always live.
  const liveRef = useRef<Set<ReportKey>>(new Set());
  const [liveKeys, setLiveKeys] = useState<ReadonlySet<ReportKey>>(new Set());
  // The view on screen and its snapshot's markLive, as of the last commit — a
  // live answer for another list must not mark this one live.
  const viewRef = useRef<ReportKey>(current);
  const markLiveRef = useRef<() => void>(() => {});

  const load = useCallback(async (svc: Service, m: Mode) => {
    const k: ReportKey = `${svc}:${m}`;
    const seq = (loadSeq.current[k] ?? 0) + 1;
    loadSeq.current[k] = seq;
    // A newer load of this list owns its state from here on.
    const superseded = () => loadSeq.current[k] !== seq;
    setLoadingKeys((prev) => new Set(prev).add(k));
    setErrors((e) => ({ ...e, [k]: "" }));
    try {
      const res = await fetch(missingListUrl(svc, m));
      if (!res.ok) {
        const message = await readError(res, t("adminManage.missing.error.load"));
        if (superseded()) return;
        setErrors((e) => ({ ...e, [k]: message }));
        return;
      }
      const data = await res.json();
      if (superseded()) return;
      // This list now holds a live answer: no snapshot paints over it from here
      // on (the ref is what a snapshot landing in the same tick reads), its
      // snapshot read stops and the stale note goes.
      const replacesLive = liveRef.current.has(k);
      liveRef.current.add(k);
      setLiveKeys(new Set(liveRef.current));
      if (viewRef.current === k) markLiveRef.current();
      setReports((r) => ({ ...r, [k]: data }));
      // A fresh listing after an earlier LIVE one (Refresh) is a fresh start:
      // the rows that were searched may be gone, and any still listed can be
      // searched again; every expanded episode list belongs to the old
      // listing. A row whose search is still IN FLIGHT keeps its state — its
      // request settles it, and until then its Search stays off (a cleared
      // entry re-armed the button mid-request). The FIRST live answer replaces
      // at most a snapshot, whose rows are the same rows (instance + id): what
      // the admin ticked or searched on it stands — re-arming a row searched a
      // moment ago would let it be searched twice.
      if (replacesLive) {
        updateSearches((s) => Object.fromEntries(Object.entries(s).filter(([key, st]) => !key.startsWith(`${k}|`) || st.busy)));
        setSelected((prev) => new Set([...prev].filter((key) => !key.startsWith(`${k}|`))));
        setBulkResult((r) => (r?.key === k ? null : r));
        setExpanded((prev) => new Set([...prev].filter((key) => !key.startsWith(`${k}|`))));
        setEpisodes((s) => Object.fromEntries(Object.entries(s).filter(([key]) => !key.startsWith(`${k}|`))));
      }
    } catch {
      if (superseded()) return;
      setErrors((e) => ({ ...e, [k]: t("adminManage.missing.error.loadNetwork") }));
    } finally {
      if (!superseded()) {
        setLoadingKeys((prev) => {
          const next = new Set(prev);
          next.delete(k);
          return next;
        });
      }
    }
  }, [t, updateSearches]);

  const loadingHere = loadingKeys.has(current);
  // Not while a load of this list is already out: switching away and back
  // mid-load used to start a second live listing of the same report.
  const needsLoad = configured[service] && !reports[current] && !errors[current] && !loadingHere;
  useEffect(() => {
    if (needsLoad) void load(service, mode);
  }, [needsLoad, service, mode, load]);

  // A snapshot only ever fills a list with no live answer yet, and never while
  // the admin has something going on that list: a bulk search (its runner and
  // the selection it took stay exactly as they are — a run whose list isn't
  // committed yet counts), its confirmation, or a row's own search in flight.
  // It sets the report alone — never an error, a selection, a dialog or a
  // row's search state.
  const snapshotMayPaint = (k: ReportKey) =>
    !liveRef.current.has(k) &&
    !(bulkAbort.current !== null && (bulk === null || bulk.key === k)) &&
    confirming?.key !== k &&
    !Object.entries(searchesRef.current).some(([key, st]) => st.busy && key.startsWith(`${k}|`));

  // The snapshot of this view's read, painted while it has no live answer —
  // on open and on each tab/mode switch. Null once a live answer landed (a
  // Refresh is live, never a snapshot) and while nothing is configured.
  const snapshotUrl = configured[service] && !liveKeys.has(current) ? missingListUrl(service, mode) : null;
  const snap = useArrSnapshot<Reports[ReportKey]>(snapshotUrl, (data) => {
    if (!snapshotMayPaint(current)) return false;
    setReports((r) => ({ ...r, [current]: data }));
  });
  useEffect(() => {
    viewRef.current = current;
    markLiveRef.current = snap.markLive;
  });

  // Keep the tab and mode in the URL so a reload or a shared link lands on
  // them. The native History API is synced with Next's router and does not
  // re-render the server page.
  function syncUrl(svc: Service, m: Mode) {
    window.history.replaceState(null, "", `?service=${svc}${m === "cutoff" ? "&mode=cutoff" : ""}`);
  }

  function switchTab(next: Service) {
    if (next === service) return;
    setService(next);
    setInstance("all");
    syncUrl(next, mode);
  }

  function switchMode(next: Mode) {
    if (next === mode) return;
    setMode(next);
    syncUrl(service, next);
  }

  // One search request; marks the row busy and reports how it went without
  // settling it — the bulk runner may wait out a 429 and ask again first.
  async function requestSearch(key: ReportKey, row: { instance: string; arrId: number }): Promise<SearchAttempt> {
    const [svc, m] = key.split(":") as [Service, Mode];
    const k = `${key}|${rowKey(row)}`;
    updateSearches((s) => ({ ...s, [k]: { busy: true, outcome: null, message: "" } }));
    try {
      const res = await fetch(withBasePath("/api/admin/missing/search"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service: svc, instance: row.instance, arrId: row.arrId, mode: m }),
      });
      if (res.ok) {
        const attempt = searchAttemptFromResponse(res.status, "", null);
        // Sonarr refused a later command after earlier ones were queued: those
        // are running, the rest of the title's gap is not being searched.
        const d = (await res.json().catch(() => null)) as { partial?: unknown } | null;
        return d?.partial === true ? { ...attempt, message: t("adminManage.missing.searchPartial") } : attempt;
      }
      const message = await readError(res, t("adminManage.missing.searchError"));
      return searchAttemptFromResponse(res.status, message, res.headers.get("Retry-After"));
    } catch {
      return { outcome: "failed", message: t("adminManage.missing.searchError") };
    }
  }

  function settleSearch(key: ReportKey, row: { instance: string; arrId: number }, outcome: SearchOutcome, message: string) {
    const k = `${key}|${rowKey(row)}`;
    const text = outcome === "failed" ? message || t("adminManage.missing.searchError") : message;
    updateSearches((s) => ({ ...s, [k]: { busy: false, outcome, message: text } }));
  }

  // A row's own Search button. A 429 here just says so — only the bulk run
  // waits it out.
  async function startSearch(key: ReportKey, row: { instance: string; arrId: number }) {
    // A row being searched can't be ticked, so its own Search takes it out of
    // the selection: left ticked, it dropped out of the cap count only while
    // busy, a failure brought it back, and the ticks then exceeded the cap.
    const k = `${key}|${rowKey(row)}`;
    setSelected((prev) => {
      if (!prev.has(k)) return prev;
      const next = new Set(prev);
      next.delete(k);
      return next;
    });
    const attempt = await requestSearch(key, row);
    settleSearch(key, row, attempt.outcome === "rateLimited" ? "failed" : attempt.outcome, attempt.message);
  }

  function toggleExpanded(k: string): boolean {
    const open = expanded.has(k);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (open) next.delete(k);
      else next.add(k);
      return next;
    });
    return open;
  }

  async function toggleMissingSeries(row: MissingSeries) {
    const k = `sonarr:missing|${rowKey(row)}`;
    const wasOpen = toggleExpanded(k);
    if (wasOpen || (episodes[k] && !episodes[k].error)) return;
    setEpisodes((m) => ({ ...m, [k]: { loading: true, error: "", episodes: [] } }));
    try {
      const qs = new URLSearchParams({ instance: row.instance, seriesId: String(row.arrId) });
      const res = await fetch(withBasePath(`/api/admin/missing/episodes?${qs}`));
      if (!res.ok) {
        const message = await readError(res, t("adminManage.missing.episodes.error"));
        setEpisodes((m) => ({ ...m, [k]: { loading: false, error: message, episodes: [] } }));
        return;
      }
      const data = (await res.json()) as { episodes: MissingEpisode[] };
      setEpisodes((m) => ({ ...m, [k]: { loading: false, error: "", episodes: data.episodes } }));
    } catch {
      setEpisodes((m) => ({ ...m, [k]: { loading: false, error: t("adminManage.missing.episodes.error"), episodes: [] } }));
    }
  }

  const report = reports[current];
  const missingMovieItems = reports["radarr:missing"]?.items;
  const missingSeriesItems = reports["sonarr:missing"]?.items;
  const cutoffMovieItems = reports["radarr:cutoff"]?.items;
  const cutoffSeriesItems = reports["sonarr:cutoff"]?.items;
  const filters: Filters = { showUnmonitored: mode === "cutoff" || showUnmonitored, instance, query };

  // The server sends each list in its default order; the other orders are
  // re-sorts of the filtered copy.
  const movies = useMemo(() => {
    const rows = applyFilters(missingMovieItems ?? [], { showUnmonitored, instance, query: deferredQuery });
    if (movieSort === "oldest") rows.sort((a, b) => a.releasedAt.localeCompare(b.releasedAt));
    else if (movieSort === "title") rows.sort((a, b) => a.title.localeCompare(b.title, locale));
    return rows;
  }, [missingMovieItems, movieSort, showUnmonitored, instance, deferredQuery, locale]);

  const series = useMemo(() => {
    const rows = applyFilters(missingSeriesItems ?? [], { showUnmonitored, instance, query: deferredQuery });
    if (seriesSort === "most") rows.sort((a, b) => b.missing - a.missing || a.title.localeCompare(b.title, locale));
    else if (seriesSort === "title") rows.sort((a, b) => a.title.localeCompare(b.title, locale));
    return rows;
  }, [missingSeriesItems, seriesSort, showUnmonitored, instance, deferredQuery, locale]);

  const cutoffMovies = useMemo(() => applyFilters(cutoffMovieItems ?? [], { showUnmonitored: true, instance, query: deferredQuery }), [cutoffMovieItems, instance, deferredQuery]);
  const cutoffSeries = useMemo(() => applyFilters(cutoffSeriesItems ?? [], { showUnmonitored: true, instance, query: deferredQuery }), [cutoffSeriesItems, instance, deferredQuery]);

  const tabCount = (svc: Service) => {
    const r = reports[`${svc}:${mode}`];
    return r ? applyFilters(r.items as Array<{ title: string; instance: string; monitored?: boolean }>, { ...filters, instance: "all", query: "" }).length : undefined;
  };

  const instanceName = (slug: string) => report?.instances.find((i) => i.slug === slug)?.name || slug || "—";
  const multiInstance = (report?.instances.length ?? 0) > 1;
  const unmonitoredCount = report && mode === "missing" ? (report.items as Array<{ monitored?: boolean }>).filter((i) => i.monitored === false).length : 0;
  const label = SERVICE_LABEL[service];
  const instanceLabel = (slug: string) => arrInstanceLabel(service, instanceName(slug), slug);

  // Once a search has started the button stays done until the next Refresh —
  // a second click would only queue the same indexer hits again. A 409 ("nothing
  // missing any more") is the title being complete, not a failure: shown in a
  // neutral tone, and the button stays off — it would only 409 again. A row a
  // running bulk search has yet to take is off too, or one click and the run
  // would search it twice.
  const searchCell = (key: ReportKey, r: { instance: string; arrId: number; title: string }) => {
    const k = `${key}|${rowKey(r)}`;
    const st = searches[k];
    const svc = key.split(":")[0] as Service;
    const ariaKey = key.endsWith(":cutoff") ? "adminManage.missing.cutoff.searchAria" : "adminManage.missing.searchAria";
    const started = st?.outcome === "started";
    const already = st?.outcome === "already";
    return (
      <td style={{ ...td, textAlign: "right", whiteSpace: "nowrap" }}>
        <Button
          size="xs"
          variant="outline"
          onClick={() => void startSearch(key, r)}
          disabled={st?.busy || started || already || bulkPending.has(k)}
          aria-label={started || already ? undefined : t(ariaKey, { service: SERVICE_LABEL[svc], title: r.title })}
        >
          {st?.busy ? <Loader2 className="animate-spin" /> : started ? <Check /> : already ? <CheckCircle2 /> : <Search />}
          {started ? t("adminManage.missing.searchStarted") : already ? t("adminArr.missingBulk.rowAlready") : t("adminManage.missing.search")}
        </Button>
        {st?.outcome === "failed" && st.message && (
          <div role="alert" style={{ fontSize: 11, color: "var(--ds-danger)", marginTop: 4, whiteSpace: "normal", maxWidth: 220, marginLeft: "auto" }}>
            {st.message}
          </div>
        )}
        {(already || started) && st.message && (
          <div role="status" style={{ fontSize: 11, color: "var(--ds-fg-muted)", marginTop: 4, whiteSpace: "normal", maxWidth: 220, marginLeft: "auto" }}>
            {st.message}
          </div>
        )}
      </td>
    );
  };

  const titleCell = (
    svc: Service,
    r: { title: string; year: number | null; posterPath: string | null; tmdbId: number | null; monitored?: boolean; instance: string; arrId: number },
    href: string | null,
  ) => (
    <div className="flex items-center gap-2">
      <Poster src={posterUrl(r.posterPath)} letter={(r.title[0] ?? "?").toUpperCase()} w={26} h={39} radius={3} />
      <div className="min-w-0">
        <div className="flex items-center gap-1" style={{ fontWeight: 500 }}>
          <span className="min-w-0">
            {href ? <Link href={href} className="hover:underline">{r.title}</Link> : r.title}
            {r.year ? <span style={{ color: "var(--ds-fg-subtle)" }}> ({r.year})</span> : null}
          </span>
          <OpenInArrLink
            service={svc}
            instance={r.instance}
            target={{ arrId: r.arrId }}
            label={t("adminManage.openIn", { name: arrInstanceLabel(svc, instanceName(r.instance), r.instance) })}
            iconOnly
          />
          {/* The title manager on what this mode is about: the file below cutoff, or the missing seasons (a movie's settings). */}
          <ManageTitleButton
            service={svc}
            instance={r.instance}
            target={{ arrId: r.arrId }}
            instanceLabel={arrInstanceLabel(svc, instanceName(r.instance), r.instance)}
            variant="icon"
            initialTab={manageTabFor(mode, svc)}
            // Removed from the arr: re-read the list so the row goes (not while
            // a bulk run is going through it — a fresh listing resets every row).
            onRemoved={() => {
              if (!bulkAbort.current) void load(svc, mode);
            }}
          />
        </div>
        {r.monitored === false && <Chip style={{ marginTop: 2 }}>{t("adminManage.missing.unmonitored")}</Chip>}
      </div>
    </div>
  );

  const profileCell = (r: { quality?: string | null; profile: string | null; cutoff: string | null }) => (
    <td style={{ ...td, fontSize: 12 }}>
      <div style={{ color: "var(--ds-fg)" }}>{r.profile ?? "—"}</div>
      {r.cutoff && <div style={{ fontSize: 11, color: "var(--ds-fg-subtle)" }}>{t("adminManage.missing.cutoff.cutoffAt", { quality: r.cutoff })}</div>}
    </td>
  );

  const tableShell = (head: React.ReactNode, rows: React.ReactNode) => (
    <div className="resp-table-scroll" style={{ border: "1px solid var(--ds-border)", borderRadius: 10 }}>
      <table className="w-full" style={{ fontSize: 13, borderCollapse: "collapse", color: "var(--ds-fg)" }}>
        <thead>
          <tr style={{ background: "var(--ds-bg-2)", textAlign: "left", color: "var(--ds-fg-subtle)", fontSize: 11 }}>{head}</tr>
        </thead>
        <tbody>{rows}</tbody>
      </table>
    </div>
  );

  // ── "Search selected" ──────────────────────────────────────────────────────
  // Each ticked row goes through the same per-row search (re-judged live, 409
  // when nothing is missing any more) via runBulkSearch, two requests at a time.
  // That pacing is only Summonarr's own: each POST answers 202 once the arr has
  // QUEUED its command, so Radarr/Sonarr — and every indexer behind them — get
  // the whole selection within minutes. Hence the cap (BULK_SEARCH_MAX; the
  // library-wide search in Arr System is the tool for more), the confirmation
  // above BULK_SEARCH_CONFIRM_OVER titles, and Cancel. Every row shows its own
  // outcome.
  // Every row the filters list, in the order shown, across every page.
  const currentRows: ReadonlyArray<BulkRow> =
    current === "radarr:missing" ? movies : current === "sonarr:missing" ? series : current === "radarr:cutoff" ? cutoffMovies : cutoffSeries;
  const viewKey = `${current}|${instance}|${query}|${showUnmonitored}|${movieSort}|${seriesSort}`;
  const pageCount = Math.max(1, Math.ceil(currentRows.length / PAGE_SIZE));
  const pageIndex = pageView.view === viewKey ? Math.min(pageView.page, pageCount - 1) : 0;
  const pageStart = pageIndex * PAGE_SIZE;
  function onPage<T>(rows: readonly T[]): T[] {
    return rows.slice(pageStart, pageStart + PAGE_SIZE);
  }
  const pageRows = onPage(currentRows);
  const selKey = (r: { instance: string; arrId: number }) => `${current}|${rowKey(r)}`;
  // A row that is being searched, was searched, or turned out complete can't be
  // ticked; one a bulk run still holds can't either.
  const isOpen = (r: BulkRow) => {
    const k = selKey(r);
    const st = searches[k];
    return !st?.busy && st?.outcome !== "started" && st?.outcome !== "already" && !bulkPending.has(k);
  };
  // The header box works on the rows on screen: this page.
  const selectable = pageRows.filter(isOpen);
  // A tick outlives a page turn and a filter change, so the selection is every
  // ticked row of this tab and mode — the listed ones in the order shown (every
  // page), then those the filters now hide. The cap, the count on the button
  // and the run all use this one list: counting only the rows on screen let a
  // filter change tick past the cap, and the run then searched fewer titles
  // than the button said.
  const shownKeys = new Set(pageRows.map(selKey));
  const listedKeys = new Set(currentRows.map(selKey));
  const selectedListed = currentRows.filter((r) => selected.has(selKey(r)) && isOpen(r));
  const selectedShown = selectable.filter((r) => selected.has(selKey(r)));
  const selectedOffPage = selectedListed.length - selectedShown.length;
  const selectedHidden = ((report?.items ?? []) as ReadonlyArray<BulkRow>).filter((r) => !listedKeys.has(selKey(r)) && selected.has(selKey(r)) && isOpen(r));
  const selectedHere = [...selectedListed, ...selectedHidden];
  // What a run takes — and so what the button says.
  const toRun = capSelection(selectedHere);
  const atCap = selectedHere.length >= BULK_SEARCH_MAX;
  // The room the cap leaves on this page beside the ticks elsewhere.
  const roomOnPage = BULK_SEARCH_MAX - selectedOffPage - selectedHidden.length;
  // Every row on screen that the cap leaves room for is ticked.
  const allSelected = selectedShown.length > 0 && selectedShown.length === Math.min(selectable.length, roomOnPage);
  const bulkRunning = bulk !== null;
  const runningHere = bulk?.key === current ? bulk : null;
  const resultHere = bulkResult?.key === current ? bulkResult : null;

  // "N started, M already complete, K failed" — the shorter forms when nothing
  // was already complete.
  const bulkSummary = (r: BulkResult) => {
    const failed = r.failed.length;
    if (r.already > 0) {
      const vars = { started: r.started, already: r.already, failed };
      return r.key.endsWith(":cutoff") ? t("adminArr.missingBulk.summaryCutoff", vars) : t("adminArr.missingBulk.summary", vars);
    }
    if (failed > 0) return t("adminArr.missingBulk.doneWithFailures", { started: r.started, failed });
    return t("adminArr.missingBulk.done", { count: r.started });
  };

  function toggleSelected(k: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else if (!atCap) next.add(k);
      return next;
    });
  }

  // The header box: on ticks the rows on screen (this page), in the order
  // shown, as far as the cap leaves room beside the ticks on other pages and
  // the ones the filters hide; off unticks the rows on screen. The ticks
  // elsewhere stay either way — "Clear selection" drops them too.
  function selectAll(on: boolean) {
    setSelected((prev) => {
      const next = new Set([...prev].filter((k) => !shownKeys.has(k)));
      if (on) for (const r of capSelection(selectable, roomOnPage)) next.add(selKey(r));
      return next;
    });
  }

  function clearSelection() {
    setSelected((prev) => new Set([...prev].filter((k) => !k.startsWith(`${current}|`))));
  }

  function requestBulk() {
    const rows = capSelection(selectedHere);
    // Not while this list is reloading: the fresh listing clears every row's
    // state and selection, mid-run.
    if (rows.length === 0 || bulkRunning || loadingHere) return;
    if (rows.length > BULK_SEARCH_CONFIRM_OVER) {
      setConfirming({ key: current, count: rows.length, unmonitored: rows.filter((r) => r.monitored === false).length });
      return;
    }
    void searchSelected(current, rows);
  }

  function confirmBulk() {
    const c = confirming;
    setConfirming(null);
    // The dialog is modal, so the selection it described is still the one here.
    if (c && c.key === current && !loadingKeys.has(current)) void searchSelected(current, capSelection(selectedHere));
  }

  function cancelBulk() {
    bulkAbort.current?.abort();
    setBulk((b) => (b ? { ...b, cancelling: true } : b));
  }

  // Re-ticks exactly the rows the last run could not search.
  function retryFailed() {
    if (!bulkResult || bulkResult.key !== current) return;
    const open = new Set(((report?.items ?? []) as ReadonlyArray<BulkRow>).filter(isOpen).map(selKey));
    const failed = bulkResult.failed.filter((k) => open.has(k)).slice(0, BULK_SEARCH_MAX);
    setSelected((prev) => new Set([...[...prev].filter((k) => !k.startsWith(`${current}|`)), ...failed]));
  }

  async function searchSelected(key: ReportKey, picked: ReadonlyArray<BulkRow>) {
    const rows = capSelection(picked);
    if (rows.length === 0 || bulkAbort.current) return;
    const controller = new AbortController();
    bulkAbort.current = controller;
    const keyOf = (r: BulkRow) => `${key}|${rowKey(r)}`;
    setBulkResult(null);
    setBulkPending(new Set(rows.map(keyOf)));
    setBulk({ key, done: 0, total: rows.length, cancelling: false });
    try {
      const summary = await runBulkSearch(rows, {
        signal: controller.signal,
        attempt: (row) => requestSearch(key, row),
        skip: (row) => {
          const st = searchesRef.current[keyOf(row)];
          return !!st && (st.busy || st.outcome === "started" || st.outcome === "already");
        },
        onSettled: (row, outcome, message) => {
          if (outcome !== "skipped") settleSearch(key, row, outcome, message);
          setBulkPending((prev) => {
            const next = new Set(prev);
            next.delete(keyOf(row));
            return next;
          });
        },
        onProgress: (done) => setBulk((b) => (b && b.key === key ? { ...b, done } : b)),
      });
      setBulkResult({
        key,
        started: summary.started,
        already: summary.already,
        failed: summary.failed.map(keyOf),
        skipped: summary.skipped,
        notRun: summary.notRun,
        total: rows.length,
        cancelled: summary.cancelled,
      });
    } finally {
      bulkAbort.current = null;
      setBulk(null);
      setBulkPending(new Set());
      setSelected((prev) => new Set([...prev].filter((k) => !k.startsWith(`${key}|`))));
    }
  }

  const selectHeader = (
    <th style={{ ...th, width: 32 }}>
      <input
        type="checkbox"
        checked={allSelected}
        disabled={selectable.length === 0 || bulkRunning}
        onChange={(e) => selectAll(e.target.checked)}
        aria-label={t("adminArr.missingBulk.selectAll")}
        className="accent-[var(--ds-accent)]"
      />
    </th>
  );
  const selectCell = (r: BulkRow) => {
    const k = `${current}|${rowKey(r)}`;
    const st = searches[k];
    const ticked = selected.has(k);
    return (
      <td style={{ ...td, width: 32 }}>
        <input
          type="checkbox"
          checked={ticked}
          disabled={st?.busy || st?.outcome === "started" || st?.outcome === "already" || bulkRunning || (!ticked && atCap)}
          onChange={() => toggleSelected(k)}
          aria-label={t("adminArr.missingBulk.selectAria", { title: r.title })}
          className="accent-[var(--ds-accent)]"
        />
      </td>
    );
  };

  const expanderCell = (k: string, title: string, onClick: () => void, cutoff = false) => {
    const open = expanded.has(k);
    const label = cutoff
      ? open ? t("adminManage.missing.cutoff.collapse", { title }) : t("adminManage.missing.cutoff.expand", { title })
      : open ? t("adminManage.missing.collapse", { title }) : t("adminManage.missing.expand", { title });
    return (
      <td style={td}>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-expanded={open}
          aria-label={label}
          onClick={onClick}
        >
          {open ? <ChevronDown /> : <ChevronRight />}
        </Button>
      </td>
    );
  };

  let table: React.ReactNode = null;
  let visibleCount = 0;
  if (current === "radarr:missing") {
    visibleCount = movies.length;
    table = tableShell(
      <>
        {selectHeader}
        <th style={th}>{t("adminManage.missing.col.title")}</th>
        {multiInstance && <th style={th}>{t("adminManage.missing.col.instance")}</th>}
        <th style={th}>{t("adminManage.missing.col.physical")}</th>
        <th style={th}>{t("adminManage.missing.col.digital")}</th>
        <th style={{ ...th, textAlign: "right" }}>{t("adminManage.missing.col.missingFor")}</th>
        <th style={th} />
      </>,
      onPage(movies).map((m) => (
        <tr key={rowKey(m)} className="hover:bg-zinc-800/20 transition-colors" style={{ borderTop: "1px solid var(--ds-border)" }}>
          {selectCell(m)}
          <td style={td}>{titleCell("radarr", m, m.tmdbId !== null ? `/movie/${m.tmdbId}` : null)}</td>
          {multiInstance && <td style={{ ...td, fontSize: 12, color: "var(--ds-fg-muted)" }}>{instanceName(m.instance)}</td>}
          <td className="ds-mono" style={{ ...td, fontSize: 12 }}>{day(m.physicalRelease)}</td>
          <td className="ds-mono" style={{ ...td, fontSize: 12 }}>{day(m.digitalRelease)}</td>
          <td className="ds-mono" style={{ ...td, fontSize: 12, textAlign: "right" }}>{t("adminManage.missing.days", { count: m.daysMissing })}</td>
          {searchCell("radarr:missing", m)}
        </tr>
      )),
    );
  } else if (current === "sonarr:missing") {
    visibleCount = series.length;
    const colSpan = multiInstance ? 7 : 6;
    table = tableShell(
      <>
        {selectHeader}
        <th style={{ ...th, width: 32 }} />
        <th style={th}>{t("adminManage.missing.col.title")}</th>
        {multiInstance && <th style={th}>{t("adminManage.missing.col.instance")}</th>}
        <th style={th}>{t("adminManage.missing.col.missing")}</th>
        <th style={th}>{t("adminManage.missing.col.seasons")}</th>
        <th style={th}>{t("adminManage.missing.col.lastAired")}</th>
        <th style={th} />
      </>,
      onPage(series).map((s) => {
        const k = `sonarr:missing|${rowKey(s)}`;
        const ep = episodes[k];
        return (
          <Fragment key={k}>
            <tr className="hover:bg-zinc-800/20 transition-colors" style={{ borderTop: "1px solid var(--ds-border)" }}>
              {selectCell(s)}
              {expanderCell(k, s.title, () => void toggleMissingSeries(s))}
              <td style={td}>{titleCell("sonarr", s, s.tmdbId !== null ? `/tv/${s.tmdbId}` : null)}</td>
              {multiInstance && <td style={{ ...td, fontSize: 12, color: "var(--ds-fg-muted)" }}>{instanceName(s.instance)}</td>}
              <td style={{ ...td, fontSize: 12 }}>
                <div>{t("adminManage.missing.episodesOf", { missing: s.missing, count: s.aired })}</div>
                {s.status && SONARR_STATUSES.has(s.status) && (
                  <div style={{ fontSize: 11, color: "var(--ds-fg-subtle)" }}>{t(`adminManage.missing.status.${s.status}`)}</div>
                )}
              </td>
              <td style={td}>
                <div className="flex flex-wrap gap-1">
                  {s.seasons.map((sn) => (
                    <span key={sn.seasonNumber} className="rounded bg-amber-500/15 text-amber-400 ds-mono" style={{ padding: "1px 6px", fontSize: 11 }}>
                      {t("adminManage.missing.seasonChip", { season: sn.seasonNumber, count: sn.missing })}
                    </span>
                  ))}
                </div>
              </td>
              <td className="ds-mono" style={{ ...td, fontSize: 12 }}>{day(s.lastAired)}</td>
              {searchCell("sonarr:missing", s)}
            </tr>
            {expanded.has(k) && (
              <tr style={{ background: "var(--ds-bg-1)" }}>
                <td colSpan={2} />
                <td colSpan={colSpan - 1} style={{ padding: "8px 10px 12px" }}>
                  {!ep || ep.loading ? (
                    <div className="flex items-center gap-2" style={{ color: "var(--ds-fg-subtle)", fontSize: 12 }}>
                      <Loader2 className="animate-spin" style={{ width: 12, height: 12 }} /> {t("adminManage.missing.episodes.loading")}
                    </div>
                  ) : ep.error ? (
                    <p role="alert" style={{ fontSize: 12, color: "var(--ds-danger)", margin: 0 }}>{ep.error}</p>
                  ) : ep.episodes.length === 0 ? (
                    <p style={{ fontSize: 12, color: "var(--ds-fg-subtle)", margin: 0 }}>{t("adminManage.missing.episodes.empty")}</p>
                  ) : (
                    <ul style={{ margin: 0, padding: 0, listStyle: "none", fontSize: 12 }} aria-label={t("adminManage.missing.episodes.label", { title: s.title })}>
                      {ep.episodes.map((e) => (
                        <li key={`${e.seasonNumber}:${e.episodeNumber}`} className="flex flex-wrap gap-x-3" style={{ padding: "2px 0" }}>
                          <span className="ds-mono" style={{ color: "var(--ds-fg-muted)" }}>{episodeCode(e)}</span>
                          <span style={{ flex: "1 1 200px" }}>{e.title || "—"}</span>
                          <span className="ds-mono" style={{ color: "var(--ds-fg-subtle)" }}>{t("adminManage.missing.episodes.aired", { date: day(e.airDateUtc) })}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
              </tr>
            )}
          </Fragment>
        );
      }),
    );
  } else if (current === "radarr:cutoff") {
    visibleCount = cutoffMovies.length;
    table = tableShell(
      <>
        {selectHeader}
        <th style={th}>{t("adminManage.missing.col.title")}</th>
        {multiInstance && <th style={th}>{t("adminManage.missing.col.instance")}</th>}
        <th style={th}>{t("adminManage.missing.cutoff.col.current")}</th>
        <th style={th}>{t("adminManage.missing.cutoff.col.profile")}</th>
        <th style={th} />
      </>,
      onPage(cutoffMovies).map((m) => (
        <tr key={rowKey(m)} className="hover:bg-zinc-800/20 transition-colors" style={{ borderTop: "1px solid var(--ds-border)" }}>
          {selectCell(m)}
          <td style={td}>{titleCell("radarr", m, m.tmdbId !== null ? `/movie/${m.tmdbId}` : null)}</td>
          {multiInstance && <td style={{ ...td, fontSize: 12, color: "var(--ds-fg-muted)" }}>{instanceName(m.instance)}</td>}
          <td className="ds-mono" style={{ ...td, fontSize: 12 }}>{m.quality ?? "—"}</td>
          {profileCell(m)}
          {searchCell("radarr:cutoff", m)}
        </tr>
      )),
    );
  } else {
    visibleCount = cutoffSeries.length;
    const colSpan = multiInstance ? 6 : 5;
    table = tableShell(
      <>
        {selectHeader}
        <th style={{ ...th, width: 32 }} />
        <th style={th}>{t("adminManage.missing.col.title")}</th>
        {multiInstance && <th style={th}>{t("adminManage.missing.col.instance")}</th>}
        <th style={th}>{t("adminManage.missing.cutoff.col.episodes")}</th>
        <th style={th}>{t("adminManage.missing.cutoff.col.profile")}</th>
        <th style={th} />
      </>,
      onPage(cutoffSeries).map((s) => {
        const k = `sonarr:cutoff|${rowKey(s)}`;
        return (
          <Fragment key={k}>
            <tr className="hover:bg-zinc-800/20 transition-colors" style={{ borderTop: "1px solid var(--ds-border)" }}>
              {selectCell(s)}
              {expanderCell(k, s.title, () => void toggleExpanded(k), true)}
              <td style={td}>{titleCell("sonarr", s, s.tmdbId !== null ? `/tv/${s.tmdbId}` : null)}</td>
              {multiInstance && <td style={{ ...td, fontSize: 12, color: "var(--ds-fg-muted)" }}>{instanceName(s.instance)}</td>}
              <td style={{ ...td, fontSize: 12 }}>{t("adminManage.missing.cutoff.episodeCount", { count: s.episodes.length })}</td>
              {profileCell(s)}
              {searchCell("sonarr:cutoff", s)}
            </tr>
            {expanded.has(k) && (
              <tr style={{ background: "var(--ds-bg-1)" }}>
                <td colSpan={2} />
                <td colSpan={colSpan - 1} style={{ padding: "8px 10px 12px" }}>
                  <ul style={{ margin: 0, padding: 0, listStyle: "none", fontSize: 12 }} aria-label={t("adminManage.missing.cutoff.episodesLabel", { title: s.title })}>
                    {s.episodes.map((e) => (
                      <li key={`${e.seasonNumber}:${e.episodeNumber}`} className="flex flex-wrap gap-x-3" style={{ padding: "2px 0" }}>
                        <span className="ds-mono" style={{ color: "var(--ds-fg-muted)" }}>{episodeCode(e)}</span>
                        <span style={{ flex: "1 1 200px" }}>{e.title || "—"}</span>
                        <span className="ds-mono" style={{ color: "var(--ds-fg-subtle)" }}>{e.quality ?? "—"}</span>
                      </li>
                    ))}
                  </ul>
                </td>
              </tr>
            )}
          </Fragment>
        );
      }),
    );
  }

  const pager = pageCount > 1 ? (
    <nav aria-label={t("adminManage.missing.page.label")} className="flex flex-wrap items-center justify-end gap-2" style={{ fontSize: 12, color: "var(--ds-fg-muted)" }}>
      <span className="ds-mono">
        {t("adminManage.missing.page.range", { from: pageStart + 1, to: Math.min(pageStart + PAGE_SIZE, currentRows.length), total: currentRows.length })}
      </span>
      <Button size="xs" variant="outline" disabled={pageIndex === 0} onClick={() => setPageView({ view: viewKey, page: pageIndex - 1 })}>
        <ChevronLeft /> {t("adminManage.missing.page.previous")}
      </Button>
      <Button size="xs" variant="outline" disabled={pageIndex >= pageCount - 1} onClick={() => setPageView({ view: viewKey, page: pageIndex + 1 })}>
        {t("adminManage.missing.page.next")} <ChevronRight />
      </Button>
    </nav>
  ) : null;

  let body: React.ReactNode;
  if (!configured[service] || (report && !report.enabled)) {
    body = (
      <EmptyState
        icon={CircleDashed}
        title={t("adminManage.missing.notConfigured.title", { service: label })}
        description={t("adminManage.missing.notConfigured.description", { service: label })}
      />
    );
  } else if (!report) {
    body = errors[current] ? (
      <p role="alert" style={{ fontSize: 13, color: "var(--ds-danger)", margin: 0 }}>{errors[current]}</p>
    ) : (
      <div className="flex items-center gap-2" style={{ color: "var(--ds-fg-subtle)", fontSize: 13 }}>
        <Loader2 className="animate-spin" style={{ width: 14, height: 14 }} /> {t("adminManage.missing.loading", { service: label })}
      </div>
    );
  } else {
    // Something is listed, but the filters (title, instance, or hiding the
    // unmonitored titles) leave none of it on screen.
    const filtered = report.items.length > 0;
    let stats: React.ReactNode;
    if (current === "radarr:missing") {
      stats = (
        <>
          <StatCard label={t("adminManage.missing.stat.movies")} value={movies.length} hint={t("adminManage.missing.stat.moviesHint")} />
          <StatCard label={t("adminManage.missing.stat.over30")} value={movies.filter((m) => m.daysMissing >= 30).length} hint={t("adminManage.missing.stat.over30Hint")} />
          <StatCard label={t("adminManage.missing.stat.unmonitored")} value={unmonitoredCount} hint={t("adminManage.missing.stat.unmonitoredHint")} />
        </>
      );
    } else if (current === "sonarr:missing") {
      stats = (
        <>
          <StatCard label={t("adminManage.missing.stat.series")} value={series.length} hint={t("adminManage.missing.stat.seriesHint")} />
          <StatCard label={t("adminManage.missing.stat.episodes")} value={series.reduce((n, s) => n + s.missing, 0)} hint={t("adminManage.missing.stat.episodesHint")} />
          <StatCard label={t("adminManage.missing.stat.unmonitored")} value={unmonitoredCount} hint={t("adminManage.missing.stat.unmonitoredHint")} />
        </>
      );
    } else if (current === "radarr:cutoff") {
      stats = <StatCard label={t("adminManage.missing.cutoff.stat.movies")} value={cutoffMovies.length} hint={t("adminManage.missing.cutoff.stat.moviesHint")} />;
    } else {
      stats = (
        <>
          <StatCard label={t("adminManage.missing.cutoff.stat.series")} value={cutoffSeries.length} hint={t("adminManage.missing.cutoff.stat.seriesHint")} />
          <StatCard
            label={t("adminManage.missing.cutoff.stat.episodes")}
            value={cutoffSeries.reduce((n, s) => n + s.episodes.length, 0)}
            hint={t("adminManage.missing.cutoff.stat.episodesHint")}
          />
        </>
      );
    }
    body = (
      <div className="flex flex-col gap-4">
        <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))" }}>{stats}</div>

        {report.errors.length > 0 && (
          <div role="status" className="rounded-md bg-amber-500/15 text-amber-400" style={{ padding: "8px 12px", fontSize: 13 }}>
            <p className="m-0">{t("adminManage.missing.arrErrors", { list: report.errors.map((e) => instanceLabel(e.instance)).join(", ") })}</p>
            {/* Why, translated from the error's kind; the raw upstream text stays in the server log. */}
            <ul className="m-0" style={{ paddingLeft: 18, marginTop: 4 }}>
              {report.errors.map((e) => (
                <li key={e.instance}>
                  {t(ARR_ERROR_KIND_KEYS[isArrErrorKind(e.kind) ? e.kind : "other"], { name: instanceLabel(e.instance) })}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Cutoff: an instance whose listing ran past the read's ceiling — the list is incomplete, and says so. */}
        {report.truncated && report.truncated.length > 0 && (
          <div role="status" className="rounded-md bg-amber-500/15 text-amber-400" style={{ padding: "8px 12px", fontSize: 13 }}>
            <ul className="m-0" style={{ paddingLeft: 18 }}>
              {report.truncated.map((e) => (
                <li key={e.instance}>{t("adminManage.missing.cutoff.truncated", { name: instanceLabel(e.instance), read: e.read, total: e.total })}</li>
              ))}
            </ul>
            <p className="m-0" style={{ marginTop: 4 }}>
              {t("adminManage.missing.cutoff.truncatedHint", { action: t("adminArr.system.searchAllCutoff") })}{" "}
              <Link href="/admin/arr-system" className="underline">{t("adminArr.missingBulk.capLink")}</Link>
            </p>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2" style={{ fontSize: 13 }}>
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value.slice(0, 200))}
            placeholder={t("adminManage.missing.filter.titlePlaceholder")}
            aria-label={t("adminManage.missing.filter.title")}
            className="w-[200px]"
          />
          {multiInstance && (
            <StyledSelect compact className="w-auto" value={instance} onChange={(e) => setInstance(e.target.value)} aria-label={t("adminManage.missing.filter.instance")}>
              <option value="all">{t("adminManage.missing.filter.allInstances")}</option>
              {report.instances.map((i) => <option key={i.slug} value={i.slug}>{i.name || i.slug}</option>)}
            </StyledSelect>
          )}
          {current === "radarr:missing" && (
            <StyledSelect compact className="w-auto" value={movieSort} onChange={(e) => setMovieSort(e.target.value as MovieSort)} aria-label={t("adminManage.missing.filter.sort")}>
              <option value="recent">{t("adminManage.missing.sort.recentRelease")}</option>
              <option value="oldest">{t("adminManage.missing.sort.oldestRelease")}</option>
              <option value="title">{t("adminManage.missing.sort.title")}</option>
            </StyledSelect>
          )}
          {current === "sonarr:missing" && (
            <StyledSelect compact className="w-auto" value={seriesSort} onChange={(e) => setSeriesSort(e.target.value as SeriesSort)} aria-label={t("adminManage.missing.filter.sort")}>
              <option value="recent">{t("adminManage.missing.sort.recentAired")}</option>
              <option value="most">{t("adminManage.missing.sort.mostMissing")}</option>
              <option value="title">{t("adminManage.missing.sort.title")}</option>
            </StyledSelect>
          )}
          {mode === "missing" ? (
            <label className="flex items-center gap-2" style={{ color: "var(--ds-fg)" }}>
              <Switch checked={showUnmonitored} onCheckedChange={setShowUnmonitored} aria-label={t("adminManage.missing.filter.unmonitored")} />
              {t("adminManage.missing.filter.unmonitored")}
            </label>
          ) : (
            <span style={{ fontSize: 12, color: "var(--ds-fg-subtle)" }}>{t("adminManage.missing.cutoff.monitoredOnly")}</span>
          )}
        </div>

        {(runningHere || selectedHere.length > 0 || (resultHere && visibleCount > 0)) && (
          <div
            role="region"
            aria-label={t("adminArr.missingBulk.region")}
            className="flex flex-col gap-2 rounded-lg"
            style={{ padding: "8px 12px", fontSize: 13, border: "1px solid var(--ds-border)", background: "var(--ds-bg-1)" }}
          >
            {runningHere ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="flex items-center gap-2" role="status">
                  <Loader2 className="animate-spin" style={{ width: 14, height: 14 }} />
                  {runningHere.cancelling
                    ? t("adminArr.missingBulk.cancelling")
                    : t("adminArr.missingBulk.progress", { done: runningHere.done, total: runningHere.total })}
                </span>
                <Button size="sm" variant="outline" disabled={runningHere.cancelling} onClick={cancelBulk} aria-label={t("adminArr.missingBulk.cancelAria")}>
                  <X /> {t("adminArr.common.cancel")}
                </Button>
              </div>
            ) : (
              <>
                {resultHere && (
                  <div className="flex flex-wrap items-center gap-2">
                    <span role="status" className="flex flex-wrap items-center gap-x-2">
                      {resultHere.failed.length === 0 && !resultHere.cancelled && <Check style={{ width: 14, height: 14 }} />}
                      <span>{bulkSummary(resultHere)}</span>
                      {resultHere.skipped > 0 && <span>{t("adminArr.missingBulk.skipped", { count: resultHere.skipped })}</span>}
                      {resultHere.cancelled && resultHere.notRun > 0 && (
                        <span>{t("adminArr.missingBulk.cancelled", { notRun: resultHere.notRun, total: resultHere.total })}</span>
                      )}
                    </span>
                    {resultHere.failed.length > 0 && (
                      <Button size="sm" variant="outline" onClick={retryFailed}>
                        <RotateCcw /> {t("adminArr.missingBulk.retryFailed")}
                      </Button>
                    )}
                  </div>
                )}
                {selectedHere.length > 0 && (
                  <div className="flex flex-wrap items-center gap-2">
                    <span>{t("adminArr.missingBulk.selected", { count: selectedHere.length })}</span>
                    {selectedOffPage > 0 && (
                      <span style={{ fontSize: 12, color: "var(--ds-fg-subtle)" }}>{t("adminArr.missingBulk.selectedOffPage", { count: selectedOffPage })}</span>
                    )}
                    {selectedHidden.length > 0 && (
                      <span style={{ fontSize: 12, color: "var(--ds-fg-subtle)" }}>{t("adminArr.missingBulk.selectedHidden", { count: selectedHidden.length })}</span>
                    )}
                    <Button size="sm" disabled={bulkRunning || loadingHere} onClick={requestBulk}>
                      <Search /> {mode === "cutoff" ? t("adminArr.missingBulk.searchCutoff", { count: toRun.length }) : t("adminArr.missingBulk.search", { count: toRun.length })}
                    </Button>
                    <Button size="sm" variant="ghost" disabled={bulkRunning} onClick={clearSelection}>{t("adminArr.missingBulk.clear")}</Button>
                    <span style={{ fontSize: 12, color: "var(--ds-fg-subtle)" }}>
                      {mode === "cutoff" ? t("adminArr.missingBulk.hintCutoff") : t("adminArr.missingBulk.hint")}
                    </span>
                  </div>
                )}
                {atCap && (
                  <p className="m-0" style={{ fontSize: 12, color: "var(--ds-fg-subtle)" }}>
                    {t("adminArr.missingBulk.capNote", {
                      max: BULK_SEARCH_MAX,
                      action: mode === "cutoff" ? t("adminArr.system.searchAllCutoff") : t("adminArr.system.searchAllMissing"),
                    })}{" "}
                    <Link href="/admin/arr-system" className="hover:underline" style={{ color: "var(--ds-accent-text)" }}>
                      {t("adminArr.missingBulk.capLink")}
                    </Link>
                  </p>
                )}
              </>
            )}
          </div>
        )}

        {visibleCount === 0 ? (
          filtered ? (
            <EmptyState icon={CircleDashed} title={t("adminManage.missing.empty.filteredTitle")} description={t("adminManage.missing.empty.filteredDescription")} />
          ) : mode === "cutoff" ? (
            <EmptyState icon={CheckCircle2} title={t("adminManage.missing.cutoff.empty.title")} description={t("adminManage.missing.cutoff.empty.description")} />
          ) : (
            <EmptyState
              icon={CheckCircle2}
              title={t("adminManage.missing.empty.title")}
              description={service === "radarr" ? t("adminManage.missing.empty.moviesDescription") : t("adminManage.missing.empty.seriesDescription")}
            />
          )
        ) : (
          <>
            {table}
            {pager}
          </>
        )}
      </div>
    );
  }

  const modeButton = (m: Mode, text: string) => (
    <button
      type="button"
      onClick={() => switchMode(m)}
      aria-pressed={mode === m}
      className="ds-hover-tint inline-flex items-center whitespace-nowrap font-medium border-0 min-h-9 sm:min-h-8"
      style={{
        padding: "5px 12px",
        borderRadius: 6,
        fontSize: 12,
        background: mode === m ? "var(--ds-bg-2)" : "transparent",
        boxShadow: mode === m ? "var(--ds-shadow-sm), inset 0 0 0 1px var(--ds-border-strong)" : undefined,
        color: mode === m ? "var(--ds-fg)" : "var(--ds-fg-muted)",
      }}
    >
      {text}
    </button>
  );

  return (
    <div className="flex flex-col gap-2">
      <FilterBar<Service>
        segments={[
          { value: "sonarr", label: SERVICE_LABEL.sonarr, count: tabCount("sonarr") },
          { value: "radarr", label: SERVICE_LABEL.radarr, count: tabCount("radarr") },
        ]}
        active={service}
        onChange={switchTab}
        right={
          <div className="flex flex-wrap items-center gap-2">
            <div
              role="group"
              aria-label={t("adminManage.missing.mode.label")}
              className="flex"
              style={{ padding: 2, background: "var(--ds-bg-1)", border: "1px solid var(--ds-border)", borderRadius: 8 }}
            >
              {modeButton("missing", t("adminManage.missing.mode.missing"))}
              {modeButton("cutoff", t("adminManage.missing.mode.cutoff"))}
            </div>
            {configured[service] ? (
              // Off while a bulk search runs on this tab: a Refresh clears every
              // row's search state, and the rows already searched could be ticked
              // and searched again.
              <Button size="sm" variant="outline" onClick={() => void load(service, mode)} disabled={loadingHere || bulk?.key === current}>
                {loadingHere ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                {t("adminManage.missing.refresh")}
              </Button>
            ) : null}
          </div>
        }
      />
      {/* The list on screen is the server's last kept answer: when it was read, and that the live read is out (or didn't finish). */}
      <ArrSnapshotNote at={snap.staleAt} refreshing={loadingHere} />
      {report && errors[current] && (
        <p role="alert" style={{ fontSize: 13, color: "var(--ds-danger)", margin: 0 }}>{errors[current]}</p>
      )}
      {/* A run keeps going on another tab or mode; its progress and Cancel stay reachable here. */}
      {bulk && bulk.key !== current && (
        <div role="status" className="flex flex-wrap items-center gap-2" style={{ fontSize: 12, color: "var(--ds-fg-muted)" }}>
          <Loader2 className="animate-spin" style={{ width: 12, height: 12 }} />
          {bulk.cancelling
            ? t("adminArr.missingBulk.cancelling")
            : t("adminArr.missingBulk.otherRunning", {
                service: SERVICE_LABEL[bulk.key.split(":")[0] as Service],
                mode: bulk.key.endsWith(":cutoff") ? t("adminManage.missing.mode.cutoff") : t("adminManage.missing.mode.missing"),
                done: bulk.done,
                total: bulk.total,
              })}
          <Button size="xs" variant="ghost" disabled={bulk.cancelling} onClick={cancelBulk} aria-label={t("adminArr.missingBulk.cancelAria")}>
            <X /> {t("adminArr.common.cancel")}
          </Button>
        </div>
      )}
      {body}

      <Dialog open={confirming !== null} onOpenChange={(o) => { if (!o) setConfirming(null); }}>
        <DialogPortal>
          <DialogBackdrop />
          <DialogPopup className="max-w-md">
            <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-700">
              <DialogTitle className="text-base font-semibold text-zinc-100">
                {confirming &&
                  (confirming.key.endsWith(":cutoff")
                    ? t("adminArr.missingBulk.confirmTitleCutoff", { count: confirming.count })
                    : t("adminArr.missingBulk.confirmTitle", { count: confirming.count }))}
              </DialogTitle>
              <DialogClose
                aria-label={t("adminArr.common.close")}
                title={t("adminArr.common.close")}
                className="text-zinc-500 hover:text-zinc-300 transition-colors"
              >
                <X className="w-5 h-5" />
              </DialogClose>
            </div>
            {confirming && (
              <div className="flex flex-col gap-3 px-6 py-4 text-sm text-zinc-400">
                <p className="m-0">
                  {t("adminArr.missingBulk.confirmBody", { count: confirming.count, service: SERVICE_LABEL[confirming.key.split(":")[0] as Service] })}
                </p>
                {confirming.unmonitored > 0 && (
                  <p className="m-0 text-amber-400">
                    {t("adminArr.missingBulk.confirmUnmonitored", {
                      count: confirming.unmonitored,
                      service: SERVICE_LABEL[confirming.key.split(":")[0] as Service],
                    })}
                  </p>
                )}
              </div>
            )}
            <div className="flex items-center justify-between px-6 py-4 border-t border-zinc-700 bg-zinc-900">
              <button type="button" onClick={() => setConfirming(null)} className="rounded px-2 py-1 text-sm text-zinc-500 hover:text-zinc-300">
                {t("adminArr.common.cancel")}
              </button>
              {confirming && (
                <Button size="sm" onClick={confirmBulk}>
                  <Search />
                  {confirming.key.endsWith(":cutoff")
                    ? t("adminArr.missingBulk.searchCutoff", { count: confirming.count })
                    : t("adminArr.missingBulk.search", { count: confirming.count })}
                </Button>
              )}
            </div>
          </DialogPopup>
        </DialogPortal>
      </Dialog>
    </div>
  );
}
