"use client";

// Admin → Calendar. What Radarr and Sonarr have coming up — and just had —
// from their own calendars (GET /api/admin/arr/calendar): every episode airing
// and every movie release date (in cinemas, physical, digital) of the titles
// they manage, two weeks at a time, grouped by the viewer's local day, with
// whether the arr has the file. A missing one can be searched from here.
//
// Every date is computed after mount from the server's `today` (guardrail 16):
// the week boundaries and day headings are in the VIEWER's time zone, which the
// server render cannot know.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Chip, EmptyState, FilterBar, type ChipTone } from "@/components/ui/design";
import { Poster } from "@/components/admin/activity-ui";
import { arrInstanceLabel } from "@/components/admin/open-in-arr";
import { episodeCode } from "@/components/admin/queue-format";
import { AlertTriangle, CalendarDays, Check, ChevronLeft, ChevronRight, Loader2, RefreshCw, Search } from "@/components/icons";
import { useHasMounted } from "@/hooks/use-has-mounted";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import { withBasePath } from "@/lib/base-path";
import { posterUrl } from "@/lib/tmdb-types";
import type { CalendarEntry, CalendarStatus } from "@/lib/arr-calendar";

type Service = "radarr" | "sonarr";
type Filter = "all" | Service;
interface InstanceRef { service: Service; slug: string; name: string }
interface Report { instances: InstanceRef[]; errors: Array<{ service: Service; instance: string; error: string }>; entries: CalendarEntry[] }

const DAYS = 14;

const STATUS_TONE: Record<CalendarStatus, ChipTone> = {
  downloaded: "approved",
  missing: "declined",
  unmonitored: "neutral",
  upcoming: "accent",
  released: "pending",
};
const STATUS_LABEL: Record<CalendarStatus, string> = {
  downloaded: "adminArr.status.downloaded",
  missing: "adminArr.status.missing",
  unmonitored: "adminArr.status.unmonitored",
  upcoming: "adminArr.status.upcoming",
  released: "adminArr.status.inCinemas",
};
const KIND_LABEL: Record<"cinema" | "physical" | "digital", string> = {
  cinema: "adminArr.releaseDate.inCinemas",
  physical: "adminArr.releaseDate.physical",
  digital: "adminArr.releaseDate.digital",
};

/** Local midnight of the Monday of the week holding `ms`. */
function weekStart(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  const back = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - back);
  return d.getTime();
}
function addDays(ms: number, n: number): number {
  const d = new Date(ms);
  d.setDate(d.getDate() + n);
  return d.getTime();
}
function localDayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}
/**
 * When an entry falls, as a local instant. An episode airs at a real time; a
 * movie's release date is a calendar date (midnight UTC), placed on that same
 * date locally — otherwise everyone west of UTC sees it a day early.
 */
function entryMs(e: CalendarEntry): number {
  const ms = Date.parse(e.date);
  if (e.kind === "episode") return ms;
  const d = new Date(ms);
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()).getTime();
}

export function ArrCalendar({ instances, today }: { instances: InstanceRef[]; today: string }) {
  const t = useT();
  const locale = useLocale();
  const mounted = useHasMounted();
  const todayMs = useMemo(() => Date.parse(today), [today]);
  // The window's first day; null until mounted (it depends on the viewer's zone).
  const [start, setStart] = useState<number | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [unmonitored, setUnmonitored] = useState(false);
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [searches, setSearches] = useState<Record<string, "busy" | "done" | string>>({});
  const seq = useRef(0);

  useEffect(() => {
    if (mounted && start === null) setStart(weekStart(todayMs));
  }, [mounted, start, todayMs]);

  const load = useCallback(async (from: number, withUnmonitored: boolean) => {
    const id = ++seq.current;
    setLoading(true);
    const q = new URLSearchParams({ start: new Date(from).toISOString(), end: new Date(addDays(from, DAYS)).toISOString() });
    if (withUnmonitored) q.set("unmonitored", "1");
    try {
      const res = await fetch(withBasePath(`/api/admin/arr/calendar?${q.toString()}`));
      const data = (await res.json().catch(() => null)) as (Report & { error?: string }) | null;
      if (id !== seq.current) return;
      if (!res.ok || !data) {
        setError(data?.error ?? t("adminArr.calendar.loadFailed"));
        return;
      }
      setReport(data);
      setError("");
    } catch {
      if (id === seq.current) setError(t("adminArr.calendar.loadFailed"));
    } finally {
      if (id === seq.current) setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (start !== null && instances.length > 0) void load(start, unmonitored);
  }, [start, unmonitored, instances.length, load]);

  async function search(e: CalendarEntry) {
    setSearches((s) => ({ ...s, [e.key]: "busy" }));
    const body = e.service === "radarr"
      ? { service: e.service, instance: e.instance, id: e.arrId, action: "search" }
      : { service: e.service, instance: e.instance, id: e.arrId, action: "searchEpisodes", episodeIds: [e.episodeId] };
    try {
      const res = await fetch(withBasePath("/api/admin/arr/title/command"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      setSearches((s) => ({ ...s, [e.key]: res.ok ? "done" : data?.error ?? t("adminArr.manage.commandFailed") }));
    } catch {
      setSearches((s) => ({ ...s, [e.key]: t("adminArr.manage.commandFailed") }));
    }
  }

  const dayFmt = useMemo(() => new Intl.DateTimeFormat(locale, { weekday: "long", month: "long", day: "numeric" }), [locale]);
  const timeFmt = useMemo(() => new Intl.DateTimeFormat(locale, { timeStyle: "short" }), [locale]);
  const rangeFmt = useMemo(() => new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", year: "numeric" }), [locale]);
  const nameOf = (service: Service, slug: string) => arrInstanceLabel(service, instances.find((i) => i.service === service && i.slug === slug)?.name, slug);
  const multi = instances.length > 1;

  // The entries inside the window's own days (the server pads movies' dates by a day).
  const inWindow = useMemo(() => {
    if (!report || start === null) return [];
    const end = addDays(start, DAYS);
    return report.entries.filter((e) => {
      const ms = entryMs(e);
      return ms >= start && ms < end;
    });
  }, [report, start]);

  const days = useMemo(() => {
    const groups = new Map<string, { ms: number; entries: CalendarEntry[] }>();
    for (const e of inWindow) {
      if (filter !== "all" && e.service !== filter) continue;
      const ms = entryMs(e);
      const key = localDayKey(ms);
      const g = groups.get(key) ?? { ms, entries: [] };
      g.entries.push(e);
      groups.set(key, g);
    }
    return [...groups.values()].sort((a, b) => a.ms - b.ms);
  }, [inWindow, filter]);

  if (instances.length === 0) {
    return <EmptyState icon={CalendarDays} title={t("adminArr.common.noneConfigured")} description={t("adminArr.common.noneConfiguredHint")} />;
  }

  const counts = report ? {
    all: inWindow.length,
    radarr: inWindow.filter((e) => e.service === "radarr").length,
    sonarr: inWindow.filter((e) => e.service === "sonarr").length,
  } : null;

  return (
    <div className="grid gap-4">
      <FilterBar
        segments={[
          { value: "all" as const, label: t("adminArr.calendar.filter.all"), count: counts?.all },
          { value: "sonarr" as const, label: t("adminArr.calendar.filter.episodes"), count: counts?.sonarr },
          { value: "radarr" as const, label: t("adminArr.calendar.filter.movies"), count: counts?.radarr },
        ]}
        active={filter}
        onChange={setFilter}
        className="mb-0"
        right={
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-xs text-zinc-400">
              <Switch size="sm" checked={unmonitored} onCheckedChange={setUnmonitored} aria-label={t("adminArr.calendar.showUnmonitored")} />
              {t("adminArr.calendar.showUnmonitored")}
            </label>
            <Button variant="outline" size="sm" disabled={start === null} onClick={() => start !== null && setStart(addDays(start, -7))} aria-label={t("adminArr.calendar.previous")}>
              <ChevronLeft />
            </Button>
            <Button variant="outline" size="sm" disabled={start === null} onClick={() => setStart(weekStart(todayMs))}>
              {t("adminArr.calendar.today")}
            </Button>
            <Button variant="outline" size="sm" disabled={start === null} onClick={() => start !== null && setStart(addDays(start, 7))} aria-label={t("adminArr.calendar.next")}>
              <ChevronRight />
            </Button>
            <Button variant="ghost" size="sm" disabled={start === null || loading} onClick={() => start !== null && void load(start, unmonitored)} aria-label={t("adminArr.common.reload")}>
              {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            </Button>
          </div>
        }
      />

      {start !== null && (
        <p className="m-0 text-sm text-zinc-400">
          {t("adminArr.calendar.range", { from: rangeFmt.format(start), to: rangeFmt.format(addDays(start, DAYS - 1)) })}
        </p>
      )}

      {error && (
        <p role="alert" className="m-0 flex items-center gap-1.5 text-sm" style={{ color: "var(--ds-danger)" }}>
          <AlertTriangle className="h-4 w-4 shrink-0" /> {error}
        </p>
      )}
      {report?.errors.map((e) => (
        <p key={`${e.service}:${e.instance}`} role="alert" className="m-0 flex items-center gap-1.5 text-xs text-amber-400">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> {t("adminArr.common.instanceDown", { name: nameOf(e.service, e.instance), error: e.error })}
        </p>
      ))}

      {!report || start === null ? (
        <div className="flex items-center gap-2 py-10 text-sm text-zinc-500"><Loader2 className="h-4 w-4 animate-spin" /> {t("adminArr.common.loading")}</div>
      ) : days.length === 0 ? (
        <EmptyState icon={CalendarDays} title={t("adminArr.calendar.empty")} description={t("adminArr.calendar.emptyHint")} />
      ) : (
        <div className="grid gap-4">
          {days.map((day) => {
            const isToday = localDayKey(day.ms) === localDayKey(todayMs);
            return (
              <section key={localDayKey(day.ms)} className="grid gap-2">
                <h2 className="m-0 flex items-center gap-2 text-sm font-semibold text-zinc-100">
                  {dayFmt.format(day.ms)}
                  {isToday && <Chip tone="accent">{t("adminArr.calendar.todayChip")}</Chip>}
                </h2>
                <ul className="m-0 grid list-none gap-0 rounded-lg p-0" style={{ border: "1px solid var(--ds-border)", background: "var(--ds-bg-1)" }}>
                  {day.entries.map((e, i) => {
                    const href = e.tmdbId !== null ? (e.service === "radarr" ? `/movie/${e.tmdbId}` : `/tv/${e.tmdbId}`) : null;
                    const st = searches[e.key];
                    const canSearch = e.status === "missing" && (e.service === "radarr" || e.episodeId !== null);
                    return (
                      <li key={e.key} className="flex items-center gap-3 px-3 py-2" style={i > 0 ? { borderTop: "1px solid var(--ds-border)" } : undefined}>
                        <Poster src={posterUrl(e.posterPath)} letter={(e.title[0] ?? "?").toUpperCase()} w={26} h={39} radius={3} />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                            {href ? (
                              <Link href={href} className="truncate text-sm font-medium text-zinc-100 hover:underline">{e.title}</Link>
                            ) : (
                              <span className="truncate text-sm font-medium text-zinc-100">{e.title}</span>
                            )}
                            {e.kind === "episode" && e.seasonNumber !== null && e.episodeNumber !== null && (
                              <span className="ds-mono text-xs text-zinc-400">{episodeCode({ seasonNumber: e.seasonNumber, episodeNumber: e.episodeNumber })}</span>
                            )}
                            {e.finaleType && <Chip tone="pending">{t("adminArr.calendar.finale")}</Chip>}
                            {e.kind === "episode" && e.episodeNumber === 1 && <Chip tone="accent">{t("adminArr.calendar.premiere")}</Chip>}
                          </div>
                          <div className="flex flex-wrap items-center gap-x-2 text-xs text-zinc-500">
                            {e.kind === "episode" ? <span className="truncate">{e.episodeTitle ?? "—"}</span> : <span>{t(KIND_LABEL[e.kind])}</span>}
                            {e.kind === "episode" && <span>{timeFmt.format(Date.parse(e.date))}</span>}
                            {e.network && <span>{e.network}</span>}
                            {multi && <span>{nameOf(e.service, e.instance)}</span>}
                          </div>
                          {st && st !== "busy" && st !== "done" && <p role="alert" className="m-0 text-xs" style={{ color: "var(--ds-danger)" }}>{st}</p>}
                        </div>
                        <Chip tone={STATUS_TONE[e.status]}>{t(STATUS_LABEL[e.status])}</Chip>
                        {canSearch && (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            disabled={st === "busy" || st === "done"}
                            onClick={() => void search(e)}
                            title={t("adminArr.calendar.search")}
                            aria-label={t("adminArr.calendar.searchAria", { title: e.title })}
                          >
                            {st === "busy" ? <Loader2 className="animate-spin" /> : st === "done" ? <Check /> : <Search />}
                          </Button>
                        )}
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
