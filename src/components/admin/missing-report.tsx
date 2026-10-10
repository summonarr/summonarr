"use client";

// Admin → Missing. One tab per service and two modes: MISSING (no file, should
// have one) and CUTOFF UNMET (a file below the quality profile's cutoff —
// Radarr/Sonarr's own /wanted/cutoff). Each (service, mode) loads its report on
// first view (it makes live Radarr/Sonarr calls, so it is never part of the
// server render) and keeps it until Refresh. A Sonarr row expands to its
// episodes — fetched on demand for Missing, already in the listing for Cutoff —
// and every row's Search queues a Radarr/Sonarr search for exactly that title's
// gap (POST /api/admin/missing/search, `mode` picking which). Every date is a
// server-supplied ISO string formatted for the viewer's locale, and "missing
// for" is a server-computed day count — nothing here reads the clock while
// rendering (guardrail 16).

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { withBasePath } from "@/lib/base-path";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import { posterUrl } from "@/lib/tmdb-types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StyledSelect } from "@/components/ui/styled-select";
import { Switch } from "@/components/ui/switch";
import { Chip, EmptyState, FilterBar, StatCard } from "@/components/ui/design";
import { Poster } from "@/components/admin/activity-ui";
import { OpenInArrLink, arrInstanceLabel } from "@/components/admin/open-in-arr";
import { Check, CheckCircle2, ChevronDown, ChevronRight, CircleDashed, Loader2, RefreshCw, Search } from "@/components/icons";
import type { CutoffMovie, CutoffSeries, MissingEpisode, MissingMovie, MissingSeries } from "@/lib/arr-missing";

type Service = "sonarr" | "radarr";
type Mode = "missing" | "cutoff";
type ReportKey = `${Service}:${Mode}`;

type Report<T> = {
  service: Service;
  enabled: boolean;
  instances: Array<{ slug: string; name: string }>;
  errors: Array<{ instance: string; error: string }>;
  items: T[];
};
type Reports = {
  "sonarr:missing"?: Report<MissingSeries>;
  "radarr:missing"?: Report<MissingMovie>;
  "sonarr:cutoff"?: Report<CutoffSeries>;
  "radarr:cutoff"?: Report<CutoffMovie>;
};
type EpisodeState = { loading: boolean; error: string; episodes: MissingEpisode[] };
type SearchState = { busy: boolean; started: boolean; error: string };

type MovieSort = "recent" | "oldest" | "title";
type SeriesSort = "recent" | "most" | "title";

const SERVICE_LABEL: Record<Service, string> = { sonarr: "Sonarr", radarr: "Radarr" };
const SONARR_STATUSES = new Set(["continuing", "ended", "upcoming", "deleted"]);
const rowKey = (r: { instance: string; arrId: number }) => `${r.instance}:${r.arrId}`;
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
  const [loading, setLoading] = useState<ReportKey | null>(null);
  const [errors, setErrors] = useState<Partial<Record<ReportKey, string>>>({});
  const [query, setQuery] = useState("");
  const [instance, setInstance] = useState("all");
  const [showUnmonitored, setShowUnmonitored] = useState(false);
  const [movieSort, setMovieSort] = useState<MovieSort>("recent");
  const [seriesSort, setSeriesSort] = useState<SeriesSort>("recent");
  // Keyed `${reportKey}|${instance}:${arrId}` — the two modes list the same series.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [episodes, setEpisodes] = useState<Record<string, EpisodeState>>({});
  // Keyed `${reportKey}|${instance}:${arrId}` — a Radarr and a Sonarr row can
  // share an instance slug and an arr id, and so can the two modes.
  const [searches, setSearches] = useState<Record<string, SearchState>>({});

  const current: ReportKey = `${service}:${mode}`;

  const load = useCallback(async (svc: Service, m: Mode) => {
    const k: ReportKey = `${svc}:${m}`;
    setLoading(k);
    setErrors((e) => ({ ...e, [k]: "" }));
    try {
      const res = await fetch(withBasePath(`/api/admin/missing?service=${svc}&mode=${m}`));
      if (!res.ok) {
        const message = await readError(res, t("adminManage.missing.error.load"));
        setErrors((e) => ({ ...e, [k]: message }));
        return;
      }
      const data = await res.json();
      setReports((r) => ({ ...r, [k]: data }));
      // A fresh listing is a fresh start: the rows that were searched may be
      // gone, and any still listed can be searched again; every expanded
      // episode list belongs to the old listing.
      setSearches((s) => Object.fromEntries(Object.entries(s).filter(([key]) => !key.startsWith(`${k}|`))));
      setExpanded((prev) => new Set([...prev].filter((key) => !key.startsWith(`${k}|`))));
      setEpisodes((s) => Object.fromEntries(Object.entries(s).filter(([key]) => !key.startsWith(`${k}|`))));
    } catch {
      setErrors((e) => ({ ...e, [k]: t("adminManage.missing.error.loadNetwork") }));
    } finally {
      setLoading((cur) => (cur === k ? null : cur));
    }
  }, [t]);

  const needsLoad = configured[service] && !reports[current] && !errors[current];
  useEffect(() => {
    if (needsLoad) void load(service, mode);
  }, [needsLoad, service, mode, load]);

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

  async function startSearch(key: ReportKey, row: { instance: string; arrId: number }) {
    const [svc, m] = key.split(":") as [Service, Mode];
    const k = `${key}|${rowKey(row)}`;
    setSearches((s) => ({ ...s, [k]: { busy: true, started: false, error: "" } }));
    try {
      const res = await fetch(withBasePath("/api/admin/missing/search"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service: svc, instance: row.instance, arrId: row.arrId, mode: m }),
      });
      if (!res.ok) {
        const message = await readError(res, t("adminManage.missing.searchError"));
        setSearches((s) => ({ ...s, [k]: { busy: false, started: false, error: message } }));
        return;
      }
      setSearches((s) => ({ ...s, [k]: { busy: false, started: true, error: "" } }));
    } catch {
      setSearches((s) => ({ ...s, [k]: { busy: false, started: false, error: t("adminManage.missing.searchError") } }));
    }
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
    const rows = applyFilters(missingMovieItems ?? [], { showUnmonitored, instance, query });
    if (movieSort === "oldest") rows.sort((a, b) => a.releasedAt.localeCompare(b.releasedAt));
    else if (movieSort === "title") rows.sort((a, b) => a.title.localeCompare(b.title, locale));
    return rows;
  }, [missingMovieItems, movieSort, showUnmonitored, instance, query, locale]);

  const series = useMemo(() => {
    const rows = applyFilters(missingSeriesItems ?? [], { showUnmonitored, instance, query });
    if (seriesSort === "most") rows.sort((a, b) => b.missing - a.missing || a.title.localeCompare(b.title, locale));
    else if (seriesSort === "title") rows.sort((a, b) => a.title.localeCompare(b.title, locale));
    return rows;
  }, [missingSeriesItems, seriesSort, showUnmonitored, instance, query, locale]);

  const cutoffMovies = useMemo(() => applyFilters(cutoffMovieItems ?? [], { showUnmonitored: true, instance, query }), [cutoffMovieItems, instance, query]);
  const cutoffSeries = useMemo(() => applyFilters(cutoffSeriesItems ?? [], { showUnmonitored: true, instance, query }), [cutoffSeriesItems, instance, query]);

  const tabCount = (svc: Service) => {
    const r = reports[`${svc}:${mode}`];
    return r ? applyFilters(r.items as Array<{ title: string; instance: string; monitored?: boolean }>, { ...filters, instance: "all", query: "" }).length : undefined;
  };

  const instanceName = (slug: string) => report?.instances.find((i) => i.slug === slug)?.name || slug || "—";
  const multiInstance = (report?.instances.length ?? 0) > 1;
  const unmonitoredCount = report && mode === "missing" ? (report.items as Array<{ monitored?: boolean }>).filter((i) => i.monitored === false).length : 0;
  const label = SERVICE_LABEL[service];

  // Once a search has started the button stays done until the next Refresh —
  // a second click would only queue the same indexer hits again.
  const searchCell = (key: ReportKey, r: { instance: string; arrId: number; title: string }) => {
    const st = searches[`${key}|${rowKey(r)}`];
    const svc = key.split(":")[0] as Service;
    const ariaKey = key.endsWith(":cutoff") ? "adminManage.missing.cutoff.searchAria" : "adminManage.missing.searchAria";
    return (
      <td style={{ ...td, textAlign: "right", whiteSpace: "nowrap" }}>
        <Button
          size="xs"
          variant="outline"
          onClick={() => void startSearch(key, r)}
          disabled={st?.busy || st?.started}
          aria-label={st?.started ? undefined : t(ariaKey, { service: SERVICE_LABEL[svc], title: r.title })}
        >
          {st?.busy ? <Loader2 className="animate-spin" /> : st?.started ? <Check /> : <Search />}
          {st?.started ? t("adminManage.missing.searchStarted") : t("adminManage.missing.search")}
        </Button>
        {st?.error && (
          <div role="alert" style={{ fontSize: 11, color: "var(--ds-danger)", marginTop: 4, whiteSpace: "normal", maxWidth: 220, marginLeft: "auto" }}>
            {st.error}
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
        <th style={th}>{t("adminManage.missing.col.title")}</th>
        {multiInstance && <th style={th}>{t("adminManage.missing.col.instance")}</th>}
        <th style={th}>{t("adminManage.missing.col.physical")}</th>
        <th style={th}>{t("adminManage.missing.col.digital")}</th>
        <th style={{ ...th, textAlign: "right" }}>{t("adminManage.missing.col.missingFor")}</th>
        <th style={th} />
      </>,
      movies.map((m) => (
        <tr key={rowKey(m)} className="hover:bg-zinc-800/20 transition-colors" style={{ borderTop: "1px solid var(--ds-border)" }}>
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
        <th style={{ ...th, width: 32 }} />
        <th style={th}>{t("adminManage.missing.col.title")}</th>
        {multiInstance && <th style={th}>{t("adminManage.missing.col.instance")}</th>}
        <th style={th}>{t("adminManage.missing.col.missing")}</th>
        <th style={th}>{t("adminManage.missing.col.seasons")}</th>
        <th style={th}>{t("adminManage.missing.col.lastAired")}</th>
        <th style={th} />
      </>,
      series.map((s) => {
        const k = `sonarr:missing|${rowKey(s)}`;
        const ep = episodes[k];
        return (
          <Fragment key={k}>
            <tr className="hover:bg-zinc-800/20 transition-colors" style={{ borderTop: "1px solid var(--ds-border)" }}>
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
                <td />
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
        <th style={th}>{t("adminManage.missing.col.title")}</th>
        {multiInstance && <th style={th}>{t("adminManage.missing.col.instance")}</th>}
        <th style={th}>{t("adminManage.missing.cutoff.col.current")}</th>
        <th style={th}>{t("adminManage.missing.cutoff.col.profile")}</th>
        <th style={th} />
      </>,
      cutoffMovies.map((m) => (
        <tr key={rowKey(m)} className="hover:bg-zinc-800/20 transition-colors" style={{ borderTop: "1px solid var(--ds-border)" }}>
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
        <th style={{ ...th, width: 32 }} />
        <th style={th}>{t("adminManage.missing.col.title")}</th>
        {multiInstance && <th style={th}>{t("adminManage.missing.col.instance")}</th>}
        <th style={th}>{t("adminManage.missing.cutoff.col.episodes")}</th>
        <th style={th}>{t("adminManage.missing.cutoff.col.profile")}</th>
        <th style={th} />
      </>,
      cutoffSeries.map((s) => {
        const k = `sonarr:cutoff|${rowKey(s)}`;
        return (
          <Fragment key={k}>
            <tr className="hover:bg-zinc-800/20 transition-colors" style={{ borderTop: "1px solid var(--ds-border)" }}>
              {expanderCell(k, s.title, () => void toggleExpanded(k), true)}
              <td style={td}>{titleCell("sonarr", s, s.tmdbId !== null ? `/tv/${s.tmdbId}` : null)}</td>
              {multiInstance && <td style={{ ...td, fontSize: 12, color: "var(--ds-fg-muted)" }}>{instanceName(s.instance)}</td>}
              <td style={{ ...td, fontSize: 12 }}>{t("adminManage.missing.cutoff.episodeCount", { count: s.episodes.length })}</td>
              {profileCell(s)}
              {searchCell("sonarr:cutoff", s)}
            </tr>
            {expanded.has(k) && (
              <tr style={{ background: "var(--ds-bg-1)" }}>
                <td />
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
          <p role="status" className="rounded-md bg-amber-500/15 text-amber-400" style={{ padding: "8px 12px", fontSize: 13, margin: 0 }}>
            {t("adminManage.missing.arrErrors", { list: report.errors.map((e) => `${label} (${instanceName(e.instance)})`).join(", ") })}
          </p>
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
          table
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
              <Button size="sm" variant="outline" onClick={() => void load(service, mode)} disabled={loading === current}>
                {loading === current ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                {t("adminManage.missing.refresh")}
              </Button>
            ) : null}
          </div>
        }
      />
      {report && errors[current] && (
        <p role="alert" style={{ fontSize: 13, color: "var(--ds-danger)", margin: 0 }}>{errors[current]}</p>
      )}
      {body}
    </div>
  );
}
