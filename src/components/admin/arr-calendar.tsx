"use client";

// Admin → Calendar. What Radarr and Sonarr have coming up — and just had —
// from their own calendars (GET /api/admin/arr/calendar): every episode airing
// and every movie release date (in cinemas, physical, digital) of the titles
// they manage, two weeks at a time, grouped by the viewer's local day, with
// whether the arr has the file or is downloading it. One row per title per day
// — a movie's dates that share a day, and a title two instances carry, fold
// together — with a status (and, when missing, a Search) per instance. Search
// re-judges the title live and never becomes an upgrade search: a movie through
// the Missing page's search, an episode through EpisodeSearch with
// `missingOnly`; a 409 carrying `nothingMissing` means there is nothing left
// to look for (any other 409 is a failure, shown with the route's message).
//
// Every date is computed after mount from the server's `today` — and then from
// each report's `now` (guardrail 16): the week boundaries, the week's first day
// and the day headings are in the VIEWER's time zone and region, which the
// server render cannot know. The view (week, status, type, instance,
// unmonitored) is kept in the URL.
//
// "Instant, then live" (src/lib/arr-snapshot.ts): opening a window paints the
// last answer the server kept for exactly that window's read (`calendarReadUrl`
// — the live load fetches the same URL, so the server's snapshot key matches),
// marked with when it was read, while the live read is out; the live answer
// then replaces it. A snapshot is drawn only for the window it was read for,
// like a live report. Searches still re-judge live on the server.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { StyledSelect } from "@/components/ui/styled-select";
import { Switch } from "@/components/ui/switch";
import { Chip, EmptyState, FilterBar, type ChipTone } from "@/components/ui/design";
import { Poster } from "@/components/admin/activity-ui";
import { arrInstanceLabel } from "@/components/admin/open-in-arr";
import { ManageTitleButton } from "@/components/admin/arr-title/title-manager";
import { ArrSnapshotNote } from "@/components/admin/arr-snapshot-note";
import { useArrSnapshot } from "@/components/admin/use-arr-snapshot";
import { episodeCode } from "@/components/admin/queue-format";
import { AlertTriangle, CalendarDays, Check, ChevronLeft, ChevronRight, Loader2, RefreshCw, Search } from "@/components/icons";
import { useHasMounted } from "@/hooks/use-has-mounted";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import { withBasePath } from "@/lib/base-path";
import { posterUrl } from "@/lib/tmdb-types";
import { ARR_ERROR_KIND_KEYS, isArrErrorKind, type ArrErrorKind } from "@/lib/arr-error-kind";
import { manageTabFor, queueTitleHref } from "@/lib/arr-manage-links";
import type { CalendarEntry, CalendarKind, CalendarStatus } from "@/lib/arr-calendar";
import {
  CALENDAR_DAYS,
  addDays,
  calendarDays,
  calendarRowCount,
  calendarViewQuery,
  entriesInWindow,
  failedInView,
  finaleOf,
  firstDayOfWeek,
  localDayKey,
  localDayStartOf,
  localEntryStatus,
  matchesStatusFilter,
  premiereOf,
  weekStart,
  type CalendarCell,
  type CalendarStatusFilter,
  type CalendarTypeFilter,
  type CalendarView,
} from "@/lib/arr-calendar-days";

type Service = "radarr" | "sonarr";
interface InstanceRef { service: Service; slug: string; name: string }
interface Report {
  instances: InstanceRef[];
  errors: Array<{ service: Service; instance: string; kind: ArrErrorKind }>;
  entries: CalendarEntry[];
  now: string;
}
/** A report and the window it was read for — a report is only ever drawn for its own window. */
interface Loaded { start: number; unmonitored: boolean; report: Report }
type SearchState = { phase: "busy" } | { phase: "started" } | { phase: "nothing" } | { phase: "failed"; message: string };

const STATUS_TONE: Record<CalendarStatus, ChipTone> = {
  downloaded: "approved",
  downloading: "pending",
  missing: "declined",
  airing: "accent",
  aired: "neutral",
  unmonitored: "neutral",
  upcoming: "accent",
  released: "pending",
};
const STATUS_LABEL: Record<CalendarStatus, string> = {
  downloaded: "adminArr.status.downloaded",
  downloading: "adminArr.status.downloading",
  missing: "adminArr.status.missing",
  airing: "adminArr.status.airing",
  aired: "adminArr.status.aired",
  unmonitored: "adminArr.status.unmonitored",
  upcoming: "adminArr.status.upcoming",
  released: "adminArr.status.inCinemas",
};
const KIND_LABEL: Record<Exclude<CalendarKind, "episode">, string> = {
  cinema: "adminArr.releaseDate.inCinemas",
  physical: "adminArr.releaseDate.physical",
  digital: "adminArr.releaseDate.digital",
};
const FINALE_LABEL = {
  series: "adminArr.calendar.seriesFinale",
  season: "adminArr.calendar.seasonFinale",
  midseason: "adminArr.calendar.midseasonFinale",
  other: "adminArr.calendar.finale",
} as const;
const PREMIERE_LABEL = {
  series: "adminArr.calendar.seriesPremiere",
  season: "adminArr.calendar.premiere",
} as const;

const canSearch = (c: CalendarCell) => c.status === "missing" && (c.service === "radarr" || c.episodeId !== null);

/**
 * The calendar read for one window. The live load and its snapshot both use
 * THIS URL — the server keys a snapshot on the read's path + query, so a
 * snapshot is only ever painted for the window (and unmonitored switch) it
 * was read for.
 */
function calendarReadUrl(from: number, withUnmonitored: boolean): string {
  const q = new URLSearchParams({ start: new Date(from).toISOString(), end: new Date(addDays(from, CALENDAR_DAYS)).toISOString() });
  if (withUnmonitored) q.set("unmonitored", "1");
  return withBasePath(`/api/admin/arr/calendar?${q.toString()}`);
}

export function ArrCalendar({ instances, today, initialView }: { instances: InstanceRef[]; today: string; initialView: CalendarView }) {
  const t = useT();
  const locale = useLocale();
  const mounted = useHasMounted();
  // The window's first day; null until mounted (it depends on the viewer's zone).
  const [start, setStart] = useState<number | null>(null);
  // ISO weekday the viewer's weeks begin on (1 = Monday); read after mount.
  const [firstDay, setFirstDay] = useState(1);
  const [statusFilter, setStatusFilter] = useState<CalendarStatusFilter>(initialView.filter);
  const [typeFilter, setTypeFilter] = useState<CalendarTypeFilter>(initialView.type);
  const [instanceFilter, setInstanceFilter] = useState(initialView.instance);
  const [unmonitored, setUnmonitored] = useState(initialView.unmonitored);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  // The newest LIVE report's clock. Not a snapshot's: one read hours ago must
  // not move "today" back while the live read is out.
  const [clock, setClock] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [searches, setSearches] = useState<Record<string, SearchState>>({});
  const seq = useRef(0);
  // No week asked for (or Today pressed): the window follows the server's
  // clock, so a mount from a cached render whose `today` is a week old still
  // lands on this week once the first report says what day it is. Previous /
  // Next pin the week the admin chose. Both are refs so `load` keeps its deps.
  const followToday = useRef(initialView.week === null);
  const firstDayRef = useRef(1);

  // "Today" follows the newest report's clock, so a page left open overnight
  // still knows which day it is.
  const nowIso = clock ?? today;
  const todayMs = useMemo(() => Date.parse(nowIso), [nowIso]);

  useEffect(() => {
    if (!mounted || start !== null) return;
    const first = firstDayOfWeek([navigator.language, locale]);
    firstDayRef.current = first;
    setFirstDay(first);
    setStart(weekStart(initialView.week ? localDayStartOf(initialView.week) : todayMs, first));
  }, [mounted, start, todayMs, locale, initialView.week]);

  // The current window's read — null until the window is known (after mount)
  // or with nothing configured to read.
  const readUrl = useMemo(
    () => (start !== null && instances.length > 0 ? calendarReadUrl(start, unmonitored) : null),
    [start, unmonitored, instances.length],
  );
  // A snapshot is a report read for THIS window: stored exactly as a live one
  // is, and drawn under the same `loaded.start === start` rule. It touches
  // nothing else — errors, searches (an in-flight one keeps its spinner) and the
  // clock stay as they are.
  const applySnapshot = useCallback((data: Report) => {
    if (start === null) return false;
    setLoaded({ start, unmonitored, report: data });
  }, [start, unmonitored]);
  const snap = useArrSnapshot<Report>(readUrl, applySnapshot);
  const { markLive } = snap;

  const load = useCallback(async (from: number, withUnmonitored: boolean) => {
    const id = ++seq.current;
    setLoading(true);
    setError("");
    try {
      const res = await fetch(calendarReadUrl(from, withUnmonitored));
      const data = (await res.json().catch(() => null)) as (Report & { error?: string }) | null;
      if (id !== seq.current) return;
      if (!res.ok || !data) {
        setError(data?.error ?? t("adminArr.calendar.loadFailed"));
        return;
      }
      const current = weekStart(Date.parse(data.now), firstDayRef.current);
      if (followToday.current && Number.isFinite(current) && current !== from) {
        // The server says it is another week: read that one instead.
        setStart(current);
        return;
      }
      setLoaded({ start: from, unmonitored: withUnmonitored, report: data });
      setClock(data.now);
      // The live answer for this window landed: a late snapshot no longer paints.
      markLive();
      // A fresh report is a fresh start: what was searched shows its new
      // status — but a search still in flight keeps its spinner (and its
      // disabled button) until its own answer arrives.
      setSearches((s) => Object.fromEntries(Object.entries(s).filter(([, v]) => v.phase === "busy")));
    } catch {
      if (id === seq.current) setError(t("adminArr.calendar.loadFailed"));
    } finally {
      if (id === seq.current) setLoading(false);
    }
  }, [t, markLive]);

  useEffect(() => {
    if (start !== null && instances.length > 0) void load(start, unmonitored);
  }, [start, unmonitored, instances.length, load]);

  // Keep the view in the URL so a reload or a shared link lands on it. The
  // current week is left out, so a bookmark keeps meaning "this week".
  useEffect(() => {
    if (start === null) return;
    const week = start === weekStart(todayMs, firstDay) ? null : localDayKey(start);
    const qs = calendarViewQuery({ week, filter: statusFilter, type: typeFilter, instance: instanceFilter, unmonitored });
    window.history.replaceState(null, "", qs ? `?${qs}` : window.location.pathname);
  }, [start, firstDay, todayMs, statusFilter, typeFilter, instanceFilter, unmonitored]);

  async function search(cell: CalendarCell) {
    setSearches((s) => ({ ...s, [cell.key]: { phase: "busy" } }));
    // Re-judged live on the server: a movie that gained a file, or an episode
    // that did (or hasn't finished airing), is a 409 — never an upgrade search.
    const [path, body] = cell.service === "radarr"
      ? ["/api/admin/missing/search", { service: "radarr", instance: cell.instance, arrId: cell.arrId, mode: "missing" }]
      : ["/api/admin/arr/title/command", { service: "sonarr", instance: cell.instance, id: cell.arrId, action: "searchEpisodes", episodeIds: [cell.episodeId], missingOnly: true }];
    try {
      const res = await fetch(withBasePath(path), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = res.ok ? null : ((await res.json().catch(() => null)) as { error?: string; nothingMissing?: boolean } | null);
      // Only the route's nothing-missing answer is "nothing left": its other
      // 409s (an episode id no longer on the series after a Sonarr refresh, the
      // arr's own refusal) are failures with the route's own message, and the
      // Search button stays.
      if (res.status === 409 && data?.nothingMissing === true) {
        setSearches((s) => ({ ...s, [cell.key]: { phase: "nothing" } }));
        return;
      }
      setSearches((s) => ({ ...s, [cell.key]: res.ok ? { phase: "started" } : { phase: "failed", message: data?.error ?? t("adminArr.manage.commandFailed") } }));
    } catch {
      setSearches((s) => ({ ...s, [cell.key]: { phase: "failed", message: t("adminArr.manage.commandFailed") } }));
    }
  }

  const dayFmt = useMemo(() => new Intl.DateTimeFormat(locale, { weekday: "long", month: "long", day: "numeric" }), [locale]);
  const timeFmt = useMemo(() => new Intl.DateTimeFormat(locale, { timeStyle: "short" }), [locale]);
  const rangeFmt = useMemo(() => new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", year: "numeric" }), [locale]);
  const pctFmt = useMemo(() => new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 }), [locale]);
  const nameOf = (service: Service, slug: string) => arrInstanceLabel(service, instances.find((i) => i.service === service && i.slug === slug)?.name, slug);
  const multi = instances.length > 1;

  // Only a report read for THIS window is drawn: while another week (or the
  // unmonitored switch) loads, the page shows the loading state, never the
  // previous window's titles under the new dates.
  const report = loaded !== null && start !== null && loaded.start === start && loaded.unmonitored === unmonitored ? loaded.report : null;

  // The entries inside the window's own days (the server pads the arrs'
  // windows), on the chosen instance — each with its status as of the viewer's
  // own day: nothing on a future local day reads missing (localEntryStatus).
  const scoped = useMemo(() => {
    if (!report || start === null) return [];
    const nowMs = Date.parse(report.now);
    return entriesInWindow(report.entries, start)
      .filter((e) => instanceFilter === "all" || `${e.service}:${e.instance}` === instanceFilter)
      .map((e) => ({ ...e, status: localEntryStatus(e, nowMs) }));
  }, [report, start, instanceFilter]);

  const days = useMemo(
    () => calendarDays(scoped.filter((e) => (typeFilter === "all" || e.service === typeFilter) && matchesStatusFilter(e.status, statusFilter))),
    [scoped, typeFilter, statusFilter],
  );

  // Each chip counts the rows it would show, given the other filters.
  const counts = useMemo(() => {
    if (!report) return null;
    const byStatus = scoped.filter((e) => matchesStatusFilter(e.status, statusFilter));
    const byType = scoped.filter((e) => typeFilter === "all" || e.service === typeFilter);
    return {
      type: {
        all: calendarRowCount(byStatus),
        radarr: calendarRowCount(byStatus.filter((e) => e.service === "radarr")),
        sonarr: calendarRowCount(byStatus.filter((e) => e.service === "sonarr")),
      },
      status: {
        all: calendarRowCount(byType),
        missing: calendarRowCount(byType.filter((e) => matchesStatusFilter(e.status, "missing"))),
        upcoming: calendarRowCount(byType.filter((e) => matchesStatusFilter(e.status, "upcoming"))),
        downloaded: calendarRowCount(byType.filter((e) => matchesStatusFilter(e.status, "downloaded"))),
      },
    };
  }, [report, scoped, statusFilter, typeFilter]);

  if (instances.length === 0) {
    return <EmptyState icon={CalendarDays} title={t("adminArr.common.noneConfigured")} description={t("adminArr.common.noneConfiguredHint")} cta={{ href: "/settings?tab=media#radarr", label: t("adminArr.common.openSettings") }} />;
  }

  // Every instance failed: "nothing on the calendar" would be a claim nobody could make.
  const allDown = report !== null && report.instances.length > 0 && report.errors.length >= report.instances.length;
  // Nor can it be made while an instance the filters include couldn't be read:
  // the amber line above names it, and its schedule is unknown, not empty.
  const viewFailed = report !== null && failedInView(report.errors, instanceFilter, typeFilter);
  const statusText = (c: CalendarCell) =>
    c.status === "downloading" && c.progress !== null
      ? t("adminArr.status.downloadingProgress", { progress: pctFmt.format(c.progress) })
      : t(STATUS_LABEL[c.status]);

  // grid-cols-1 is minmax(0, 1fr): the column never grows past the page, so a
  // filter track wider than a phone scrolls inside itself instead of the page.
  return (
    <div className="grid grid-cols-1 gap-4">
      <FilterBar
        segments={[
          { value: "all" as const, label: t("adminArr.calendar.filter.all"), count: counts?.type.all },
          { value: "sonarr" as const, label: t("adminArr.calendar.filter.episodes"), count: counts?.type.sonarr },
          { value: "radarr" as const, label: t("adminArr.calendar.filter.movies"), count: counts?.type.radarr },
        ]}
        active={typeFilter}
        onChange={setTypeFilter}
        className="mb-0"
        right={
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-xs text-zinc-400">
              <Switch size="sm" checked={unmonitored} onCheckedChange={setUnmonitored} aria-label={t("adminArr.calendar.showUnmonitored")} />
              {t("adminArr.calendar.showUnmonitored")}
            </label>
            <Button
              variant="outline"
              size="sm"
              disabled={start === null}
              onClick={() => {
                if (start === null) return;
                followToday.current = false;
                setStart(addDays(start, -7));
              }}
              aria-label={t("adminArr.calendar.previous")}
            >
              <ChevronLeft />
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={start === null}
              onClick={() => {
                followToday.current = true;
                setStart(weekStart(todayMs, firstDay));
              }}
            >
              {t("adminArr.calendar.today")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={start === null}
              onClick={() => {
                if (start === null) return;
                followToday.current = false;
                setStart(addDays(start, 7));
              }}
              aria-label={t("adminArr.calendar.next")}
            >
              <ChevronRight />
            </Button>
            <Button variant="ghost" size="sm" disabled={start === null || loading} onClick={() => start !== null && void load(start, unmonitored)} aria-label={t("adminArr.common.reload")}>
              {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            </Button>
          </div>
        }
      />
      <FilterBar
        segments={[
          { value: "all" as const, label: t("adminArr.calendar.filter.all"), count: counts?.status.all },
          { value: "missing" as const, label: t("adminArr.status.missing"), count: counts?.status.missing },
          { value: "upcoming" as const, label: t("adminArr.status.upcoming"), count: counts?.status.upcoming },
          { value: "downloaded" as const, label: t("adminArr.status.downloaded"), count: counts?.status.downloaded },
        ]}
        active={statusFilter}
        onChange={setStatusFilter}
        className="mb-0"
        right={multi ? (
          <StyledSelect compact className="w-auto" value={instanceFilter} onChange={(e) => setInstanceFilter(e.target.value)} aria-label={t("adminArr.common.instance")}>
            <option value="all">{t("adminArr.calendar.allInstances")}</option>
            {instances.map((i) => (
              <option key={`${i.service}:${i.slug}`} value={`${i.service}:${i.slug}`}>{arrInstanceLabel(i.service, i.name, i.slug)}</option>
            ))}
          </StyledSelect>
        ) : undefined}
      />

      {start !== null && (
        <p className="m-0 text-sm text-zinc-400">
          {t("adminArr.calendar.range", { from: rangeFmt.format(start), to: rangeFmt.format(addDays(start, CALENDAR_DAYS - 1)) })}
        </p>
      )}
      <ArrSnapshotNote at={snap.staleAt} refreshing={loading} />

      {error && (
        <p role="alert" className="m-0 flex items-center gap-1.5 text-sm" style={{ color: "var(--ds-danger)" }}>
          <AlertTriangle className="h-4 w-4 shrink-0" /> {error}
        </p>
      )}
      {report?.errors.map((e) => (
        <p key={`${e.service}:${e.instance}`} role="alert" className="m-0 flex items-center gap-1.5 text-xs text-amber-400">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> {t(ARR_ERROR_KIND_KEYS[isArrErrorKind(e.kind) ? e.kind : "other"], { name: nameOf(e.service, e.instance) })}
        </p>
      ))}

      {report === null ? (
        error ? null : <div className="flex items-center gap-2 py-10 text-sm text-zinc-500"><Loader2 className="h-4 w-4 animate-spin" /> {t("adminArr.common.loading")}</div>
      ) : days.length === 0 ? (
        // Titles are in the window but the status/type chips hide them all.
        error || allDown ? null : scoped.length > 0 ? (
          <EmptyState
            icon={CalendarDays}
            title={t("adminArr.calendar.emptyFiltered")}
            description={t("adminArr.calendar.emptyFilteredHint")}
            action={
              <Button variant="outline" size="sm" onClick={() => { setStatusFilter("all"); setTypeFilter("all"); }}>
                {t("adminArr.calendar.clearFilters")}
              </Button>
            }
          />
        ) : viewFailed ? null : (
          <EmptyState
            icon={CalendarDays}
            title={t("adminArr.calendar.empty")}
            description={t(unmonitored ? "adminArr.calendar.emptyHintAll" : "adminArr.calendar.emptyHint")}
          />
        )
      ) : (
        <div className="grid grid-cols-1 gap-4 transition-opacity" style={loading ? { opacity: 0.6 } : undefined} aria-busy={loading}>
          {days.map((day) => {
            const isToday = day.key === localDayKey(todayMs);
            return (
              <section key={day.key} className="grid grid-cols-1 gap-2">
                <h2 className="m-0 flex items-center gap-2 text-sm font-semibold text-zinc-100">
                  {dayFmt.format(day.ms)}
                  {isToday && <Chip tone="accent">{t("adminArr.calendar.todayChip")}</Chip>}
                </h2>
                <ul className="m-0 grid grid-cols-1 list-none gap-0 rounded-lg p-0" style={{ border: "1px solid var(--ds-border)", background: "var(--ds-bg-1)" }}>
                  {day.rows.map((row, i) => {
                    const e = row.entry;
                    const href = row.tmdbId !== null ? (e.service === "radarr" ? `/movie/${row.tmdbId}` : `/tv/${row.tmdbId}`) : null;
                    const premiere = premiereOf(e);
                    const finale = finaleOf(e.finaleType);
                    const releaseKinds = row.kinds.filter((k): k is Exclude<CalendarKind, "episode"> => k !== "episode");
                    return (
                      // The per-instance cells wrap under the title on a narrow screen.
                      <li key={row.key} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2" style={i > 0 ? { borderTop: "1px solid var(--ds-border)" } : undefined}>
                        <Poster src={posterUrl(row.posterPath)} letter={(e.title[0] ?? "?").toUpperCase()} w={26} h={39} radius={3} />
                        <div className="min-w-0 flex-1 basis-48">
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                            {href ? (
                              <Link href={href} className="truncate text-sm font-medium text-zinc-100 hover:underline">{e.title}</Link>
                            ) : (
                              <span className="truncate text-sm font-medium text-zinc-100">{e.title}</span>
                            )}
                            {e.kind === "episode" && e.seasonNumber !== null && e.episodeNumber !== null && (
                              <span className="ds-mono text-xs text-zinc-400">{episodeCode({ seasonNumber: e.seasonNumber, episodeNumber: e.episodeNumber })}</span>
                            )}
                            {premiere && <Chip tone="accent">{t(PREMIERE_LABEL[premiere])}</Chip>}
                            {finale && <Chip tone="pending">{t(FINALE_LABEL[finale])}</Chip>}
                          </div>
                          <div className="flex flex-wrap items-center gap-x-2 text-xs text-zinc-500">
                            {e.kind === "episode" ? <span className="truncate">{e.episodeTitle ?? "—"}</span> : <span>{releaseKinds.map((k) => t(KIND_LABEL[k])).join(" · ")}</span>}
                            {e.kind === "episode" && <span>{timeFmt.format(Date.parse(e.date))}</span>}
                            {e.network && <span>{e.network}</span>}
                          </div>
                          {row.cells.map((c) => {
                            const st = searches[c.key];
                            const prefix = multi ? `${nameOf(c.service, c.instance)}: ` : "";
                            if (st?.phase === "failed") {
                              return <p key={c.key} role="alert" className="m-0 text-xs" style={{ color: "var(--ds-danger)" }}>{prefix}{st.message}</p>;
                            }
                            if (st?.phase === "nothing") {
                              return <p key={c.key} role="status" className="m-0 text-xs text-zinc-400">{prefix}{t("adminArr.calendar.nothingToSearch")}</p>;
                            }
                            return null;
                          })}
                        </div>
                        <div className="ml-auto flex shrink-0 flex-col items-end gap-1">
                          {row.cells.map((c) => {
                            const st = searches[c.key];
                            const searchable = canSearch(c) && st?.phase !== "nothing";
                            return (
                              <div key={c.key} className="flex items-center gap-1.5">
                                {multi && <span className="text-xs text-zinc-500">{nameOf(c.service, c.instance)}</span>}
                                <Chip tone={STATUS_TONE[c.status]}>{statusText(c)}</Chip>
                                {/* Radarr/Sonarr's own verdict on the download (import blocked, a
                                    tracked warning): the queue row is where it gets fixed. */}
                                {c.attention && (
                                  <Link
                                    href={queueTitleHref({ service: c.service, instance: c.instance, arrId: c.arrId })}
                                    className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-accent-ring)]"
                                  >
                                    <Chip tone="pending" className="hover:underline">
                                      <AlertTriangle style={{ width: 11, height: 11 }} aria-hidden /> {t("adminManage.queue.attention")}
                                    </Chip>
                                  </Link>
                                )}
                                {searchable && (
                                  <Button
                                    variant="ghost"
                                    size="icon-sm"
                                    disabled={st?.phase === "busy" || st?.phase === "started"}
                                    onClick={() => void search(c)}
                                    title={st?.phase === "started" ? t("adminArr.calendar.searchStarted") : t("adminArr.calendar.search")}
                                    aria-label={multi
                                      ? t("adminArr.calendar.searchAriaOn", { title: e.title, instance: nameOf(c.service, c.instance) })
                                      : t("adminArr.calendar.searchAria", { title: e.title })}
                                  >
                                    {st?.phase === "busy" ? <Loader2 className="animate-spin" /> : st?.phase === "started" ? <Check /> : <Search />}
                                  </Button>
                                )}
                                {/* The title on THIS instance — a row folds every instance that carries it. */}
                                <ManageTitleButton
                                  service={c.service}
                                  instance={c.instance}
                                  target={{ arrId: c.arrId }}
                                  instanceLabel={nameOf(c.service, c.instance)}
                                  variant="icon"
                                  initialTab={manageTabFor("calendar", c.service)}
                                  // Removed from the arr: re-read the weeks so its entries go.
                                  onRemoved={() => {
                                    if (start !== null) void load(start, unmonitored);
                                  }}
                                />
                              </div>
                            );
                          })}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </div>
      )}
      <p className="m-0 text-xs text-zinc-500">{t("adminArr.calendar.footnote")}</p>
    </div>
  );
}
