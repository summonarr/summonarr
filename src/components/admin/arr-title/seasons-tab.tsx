"use client";

// The title manager's Seasons tab (Sonarr): Sonarr's own series page in one
// list — monitor or unmonitor each season (Sonarr sets its episodes to match)
// and each episode, search a season or an episode, or pick a release by hand
// for either. Episodes load per season on every expand
// (GET /api/admin/arr/title/episodes), and an open list is read again whenever
// the title is re-read with that season's header changed (a file deleted in
// the Files tab, a refresh or a search finishing) — use-episode-lists.ts.
// Air-date verdicts are judged against the server's time when the list was
// read, never a clock read here (guardrail 16).
//
// Rows are wrapping flex rows, not a fixed-width table: at phone width a
// table's actions sat off-screen.
//
// "Instant, then live" (src/lib/arr-snapshot.ts): a season opened for the first
// time paints the list the server last read for it while its live read is out
// — or after that read failed — never over rows already shown, never for a
// read a newer one superseded, never while a flip or search of this tab is in
// flight.

import { useCallback, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Chip } from "@/components/ui/design";
import { AlertTriangle, ChevronDown, ChevronRight, Loader2, RefreshCw, Search, Download } from "@/components/icons";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import { ArrSnapshotNote } from "@/components/admin/arr-snapshot-note";
import { episodeCode, queueFormatters } from "@/components/admin/queue-format";
import type { ArrTitle, TitleEpisode, TitleSeason } from "@/lib/arr-title";
import { TITLE_WRITE } from "@/lib/client/arr-answers";
import { useAsyncAction } from "@/hooks/use-async-action";
import { arrApi, useTRef, type TitleRef } from "./shared";
import { useEpisodeLists, type EpisodeList } from "./use-episode-lists";

export type ReleaseScope = { seasonNumber: number } | { episodeId: number };

// Sonarr's finale kinds, translated (a literal map — never a built key).
const FINALE_KEYS: Record<string, string> = {
  series: "adminArr.calendar.seriesFinale",
  season: "adminArr.calendar.seasonFinale",
  midseason: "adminArr.calendar.midseasonFinale",
};

type Formatters = ReturnType<typeof queueFormatters>;

export function SeasonsTab({
  titleRef,
  title,
  onTitle,
  runCommand,
  pickRelease,
}: {
  titleRef: TitleRef;
  title: ArrTitle;
  /**
   * The series as Sonarr has it after a season or episode flip — null when the
   * flip landed but its re-read failed (the manager reads it again).
   */
  onTitle: (title: ArrTitle | null) => void;
  /** Queue one title command; resolves once the server answered. */
  runCommand: (body: Record<string, unknown>, done: string, signal?: AbortSignal) => Promise<void>;
  pickRelease: (scope: ReleaseScope, subtitle: string) => void;
}) {
  const t = useT();
  const tRef = useTRef();
  const locale = useLocale();
  const fmt = useMemo(() => queueFormatters(locale), [locale]);
  const day = useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: "medium" }), [locale]);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
  const [error, setError] = useState("");
  // Every flip and search, under its control's key (`season:<n>`,
  // `episode:<id>`, `search:<n>`, `ep:<id>`): one at a time on the tab, and
  // the manager closing aborts what is out.
  const action = useAsyncAction();
  const writing = useCallback(() => action.anyBusy, [action]);
  const { lists, loadEpisodes, markSeen, readInFlight, setEpisodeMonitored: showEpisodeMonitored } = useEpisodeLists({
    titleRef,
    seasons: title.seasons,
    expanded,
    writing,
    tRef,
  });
  const anime = title.seriesType === "anime";

  // Newest season first, specials last — Sonarr's own order.
  const seasons = [...title.seasons].sort((a, b) => (a.seasonNumber === 0 ? 1 : b.seasonNumber === 0 ? -1 : b.seasonNumber - a.seasonNumber));
  const seasonLabel = (n: number) => (n === 0 ? t("adminArr.seasons.specials") : t("adminArr.seasons.season", { number: n }));

  function toggle(n: number) {
    const opening = !expanded.has(n);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (opening) next.add(n);
      else next.delete(n);
      return next;
    });
    // Every expand reads the list again (its rows stay shown meanwhile): a
    // collapsed list is not kept up to date, and this is also the retry for a
    // list that failed to load.
    if (opening) void loadEpisodes(n);
  }

  async function setSeasonMonitored(season: TitleSeason, monitored: boolean) {
    const n = season.seasonNumber;
    const key = `season:${n}`;
    setError("");
    const res = await action.run(
      key,
      (signal) =>
        arrApi(
          "/api/admin/arr/title",
          { method: "PATCH", body: { service: titleRef.service, instance: titleRef.instance, id: titleRef.arrId, seasons: [{ seasonNumber: n, monitored }] }, schema: TITLE_WRITE, signal },
          t("adminArr.settings.saveFailed"),
        ),
      { ifBusy: "skip" },
    );
    if (!res) return;
    if (!res.ok) {
      setError(res.error);
      return;
    }
    markSeen(res.data.title, n);
    onTitle(res.data.title);
    // Sonarr set the season's episodes to match; re-read an open list BEFORE
    // the switches come back — until it answers, its rows show the episodes'
    // old monitoring, and a flip made from them would race this read. The
    // re-read runs under the flip's own key, which holds every control.
    if (expanded.has(n) && lists[n]) await action.run(key, () => loadEpisodes(n));
  }

  async function setEpisodeMonitored(season: number, ep: TitleEpisode, monitored: boolean) {
    setError("");
    const res = await action.run(
      `episode:${ep.id}`,
      (signal) =>
        arrApi(
          "/api/admin/arr/title/episodes",
          { method: "PATCH", body: { service: titleRef.service, instance: titleRef.instance, id: titleRef.arrId, episodeIds: [ep.id], monitored }, schema: TITLE_WRITE, signal },
          t("adminArr.settings.saveFailed"),
        ),
      { ifBusy: "skip" },
    );
    if (!res) return;
    if (!res.ok) {
      setError(res.error);
      return;
    }
    // A read of this season still in flight was sent before the flip landed
    // and carries the old value: start a newer one — only the newest read
    // writes the list.
    if (readInFlight(season)) void loadEpisodes(season);
    showEpisodeMonitored(season, ep.id, monitored);
    // The counts follow monitoring (unmonitoring the one missing aired episode
    // is what makes a series read complete) — show Sonarr's new ones.
    markSeen(res.data.title, season);
    onTitle(res.data.title);
  }

  function command(key: string, body: Record<string, unknown>, done: string) {
    void action.run(key, (signal) => runCommand(body, done, signal), { ifBusy: "skip" });
  }

  if (seasons.length === 0) return <p className="m-0 text-sm text-zinc-500">{t("adminArr.seasons.none")}</p>;

  return (
    <div className="grid grid-cols-1 gap-3">
      {!title.monitored && (
        <p role="note" className="m-0 flex items-start gap-1.5 rounded-lg px-3 py-2 text-xs text-amber-400" style={{ background: "color-mix(in oklab, var(--ds-warning) 10%, transparent)" }}>
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {t("adminArr.seasons.seriesUnmonitored")}
        </p>
      )}
      {error && (
        <p role="alert" className="m-0 flex items-center gap-1.5 text-xs" style={{ color: "var(--ds-danger)" }}>
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> {error}
        </p>
      )}
      <ul className="m-0 list-none overflow-hidden rounded-lg p-0" style={{ border: "1px solid var(--ds-border)" }}>
        {seasons.map((s, i) => (
          <SeasonRow
            key={s.seasonNumber}
            season={s}
            first={i === 0}
            label={seasonLabel(s.seasonNumber)}
            seriesMonitored={title.monitored}
            open={expanded.has(s.seasonNumber)}
            list={lists[s.seasonNumber]}
            busy={action.anyBusy}
            isBusy={action.busy}
            anime={anime}
            fmt={fmt}
            day={day}
            onToggle={() => toggle(s.seasonNumber)}
            onMonitor={(v) => void setSeasonMonitored(s, v)}
            onSearch={() => command(`search:${s.seasonNumber}`, { action: "searchSeason", seasonNumber: s.seasonNumber }, t("adminArr.notice.seasonSearch", { season: seasonLabel(s.seasonNumber) }))}
            onPick={() => pickRelease({ seasonNumber: s.seasonNumber }, seasonLabel(s.seasonNumber))}
            onRetry={() => void loadEpisodes(s.seasonNumber)}
            onEpisodeMonitor={(ep, v) => void setEpisodeMonitored(s.seasonNumber, ep, v)}
            onEpisodeSearch={(ep) => command(`ep:${ep.id}`, { action: "searchEpisodes", episodeIds: [ep.id] }, t("adminArr.notice.episodeSearch", { episode: episodeCode(ep) }))}
            onEpisodePick={(ep) => pickRelease({ episodeId: ep.id }, `${episodeCode(ep)} · ${ep.title}`)}
          />
        ))}
      </ul>
    </div>
  );
}

/** One season: its header row (monitor, counts, size, search, pick a release) and, expanded, its episodes. */
function SeasonRow({ season: s, first, label, seriesMonitored, open, list, busy, isBusy, anime, fmt, day, onToggle, onMonitor, onSearch, onPick, onRetry, onEpisodeMonitor, onEpisodeSearch, onEpisodePick }: {
  season: TitleSeason;
  first: boolean;
  label: string;
  seriesMonitored: boolean;
  open: boolean;
  list: EpisodeList | undefined;
  /** A flip or search of the tab is out: every control waits. */
  busy: boolean;
  /** Whether that one is this control's (its key). */
  isBusy: (key: string) => boolean;
  anime: boolean;
  fmt: Formatters;
  day: Intl.DateTimeFormat;
  onToggle: () => void;
  onMonitor: (monitored: boolean) => void;
  onSearch: () => void;
  onPick: () => void;
  onRetry: () => void;
  onEpisodeMonitor: (ep: TitleEpisode, monitored: boolean) => void;
  onEpisodeSearch: (ep: TitleEpisode) => void;
  onEpisodePick: (ep: TitleEpisode) => void;
}) {
  const t = useT();
  const complete = s.episodeCount > 0 && s.episodeFileCount >= s.episodeCount;
  const searchHint = !seriesMonitored || !s.monitored ? t("adminArr.seasons.searchUnmonitored") : t("adminArr.seasons.searchSeason");
  return (
    <li style={!first ? { borderTop: "1px solid var(--ds-border)" } : undefined}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="flex min-w-[7rem] items-center gap-1.5 font-medium text-zinc-100 hover:text-zinc-100"
        >
          {open ? <ChevronDown className="h-4 w-4 text-zinc-500" /> : <ChevronRight className="h-4 w-4 text-zinc-500" />}
          {label}
        </button>
        <Switch
          size="sm"
          checked={s.monitored}
          loading={isBusy(`season:${s.seasonNumber}`)}
          disabled={busy}
          onCheckedChange={onMonitor}
          aria-label={t("adminArr.seasons.monitorSeason", { season: label })}
        />
        <span className="whitespace-nowrap">
          <Chip tone={complete ? "approved" : s.episodeFileCount > 0 ? "pending" : "neutral"}>
            {t("adminArr.seasons.files", { have: s.episodeFileCount, count: s.episodeCount })}
          </Chip>
          {s.totalEpisodeCount > s.episodeCount && (
            <span className="ml-2 text-xs text-zinc-500">{t("adminArr.seasons.total", { count: s.totalEpisodeCount })}</span>
          )}
        </span>
        <span className="text-xs text-zinc-500 whitespace-nowrap">
          {s.sizeOnDisk > 0 ? fmt.size(s.sizeOnDisk) : ""}
          {s.nextAiring && <span className="ml-2">{t("adminArr.seasons.nextAiring", { date: day.format(Date.parse(s.nextAiring)) })}</span>}
        </span>
        <span className="ml-auto flex gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={busy}
            title={searchHint}
            aria-label={t("adminArr.seasons.searchSeasonAria", { season: label })}
            onClick={onSearch}
          >
            {isBusy(`search:${s.seasonNumber}`) ? <Loader2 className="animate-spin" /> : <Search />}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={busy}
            title={t("adminArr.actions.interactive")}
            aria-label={t("adminArr.seasons.interactiveAria", { season: label })}
            onClick={onPick}
          >
            <Download />
          </Button>
        </span>
      </div>
      {open && (
        <div className="px-3 pb-3" style={{ background: "var(--ds-bg-1)" }}>
          <ArrSnapshotNote at={list?.staleAt ?? null} refreshing={list?.loading ?? false} />
          {!list || (list.loading && list.episodes.length === 0) ? (
            <div className="flex items-center gap-2 py-3 text-xs text-zinc-500"><Loader2 className="h-4 w-4 animate-spin" /> {t("adminArr.common.loading")}</div>
          ) : list.error && list.episodes.length === 0 ? (
            <p role="alert" className="m-0 flex flex-wrap items-center gap-2 py-3 text-xs" style={{ color: "var(--ds-danger)" }}>
              {list.error}
              <Button variant="ghost" size="xs" onClick={onRetry}>
                <RefreshCw /> {t("adminArr.common.retry")}
              </Button>
            </p>
          ) : list.episodes.length === 0 ? (
            <p className="m-0 py-3 text-xs text-zinc-500">{t("adminArr.seasons.noEpisodes")}</p>
          ) : (
            // grid-cols-1 (minmax(0, 1fr)): an implicit grid column sizes to the
            // rows' max-content and pushed the episode rows past the dialog edge.
            <ul className="m-0 grid grid-cols-1 list-none gap-0 p-0">
              {list.error && <li role="alert" className="py-2 text-xs" style={{ color: "var(--ds-danger)" }}>{list.error}</li>}
              {list.episodes.map((ep) => (
                <EpisodeRow
                  key={ep.id}
                  ep={ep}
                  loadedAt={list.loadedAt}
                  seriesMonitored={seriesMonitored}
                  anime={anime}
                  day={day}
                  busy={busy}
                  isBusy={isBusy}
                  onMonitor={(v) => onEpisodeMonitor(ep, v)}
                  onSearch={() => onEpisodeSearch(ep)}
                  onPick={() => onEpisodePick(ep)}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}

function EpisodeRow({ ep, loadedAt, seriesMonitored, anime, day, busy, isBusy, onMonitor, onSearch, onPick }: {
  ep: TitleEpisode;
  /** The server's time when the list was read: "aired" is judged against it. */
  loadedAt: number;
  seriesMonitored: boolean;
  anime: boolean;
  day: Intl.DateTimeFormat;
  busy: boolean;
  isBusy: (key: string) => boolean;
  onMonitor: (monitored: boolean) => void;
  onSearch: () => void;
  onPick: () => void;
}) {
  const t = useT();
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2" style={{ borderTop: "1px solid var(--ds-border)" }}>
      <Switch
        size="sm"
        checked={ep.monitored}
        loading={isBusy(`episode:${ep.id}`)}
        disabled={busy}
        onCheckedChange={onMonitor}
        aria-label={t("adminArr.seasons.monitorEpisode", { episode: episodeCode(ep) })}
      />
      <span className="ds-mono text-xs text-zinc-500">
        {episodeCode(ep)}
        {/* Anime is named and matched by absolute number — Sonarr leads with it. */}
        {anime && ep.absoluteEpisodeNumber !== null && ` (#${ep.absoluteEpisodeNumber})`}
      </span>
      {/* A floor on the title's width makes a narrow row wrap rather than squeeze it to nothing. */}
      <span className="min-w-[8rem] flex-1 truncate text-sm text-zinc-200" title={ep.title}>{ep.title || "—"}</span>
      <span className="whitespace-nowrap text-xs text-zinc-500">{ep.airDateUtc ? day.format(Date.parse(ep.airDateUtc)) : t("adminArr.seasons.tba")}</span>
      {ep.finaleType && FINALE_KEYS[ep.finaleType] && <Chip tone="accent">{t(FINALE_KEYS[ep.finaleType])}</Chip>}
      <EpisodeStatus ep={ep} loadedAt={loadedAt} seriesMonitored={seriesMonitored} />
      <span className="flex gap-1">
        <Button
          variant="ghost"
          size="icon-xs"
          disabled={busy}
          title={t("adminArr.seasons.searchEpisode")}
          aria-label={t("adminArr.seasons.searchEpisodeAria", { episode: episodeCode(ep) })}
          onClick={onSearch}
        >
          {isBusy(`ep:${ep.id}`) ? <Loader2 className="animate-spin" /> : <Search />}
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          disabled={busy}
          title={t("adminArr.actions.interactive")}
          aria-label={t("adminArr.seasons.interactiveEpisodeAria", { episode: episodeCode(ep) })}
          onClick={onPick}
        >
          <Download />
        </Button>
      </span>
    </li>
  );
}

function EpisodeStatus({ ep, loadedAt, seriesMonitored }: { ep: TitleEpisode; loadedAt: number; seriesMonitored: boolean }) {
  const t = useT();
  if (ep.hasFile) return <Chip tone="approved">{t("adminArr.status.downloaded")}</Chip>;
  const aired = ep.airDateUtc !== null && Date.parse(ep.airDateUtc) <= loadedAt;
  if (!aired) return <Chip>{t("adminArr.status.unaired")}</Chip>;
  // Sonarr never searches an unmonitored episode, or anything of an unmonitored series.
  if (!ep.monitored || !seriesMonitored) return <Chip>{t("adminArr.status.unmonitored")}</Chip>;
  return <Chip tone="declined">{t("adminArr.status.missing")}</Chip>;
}
