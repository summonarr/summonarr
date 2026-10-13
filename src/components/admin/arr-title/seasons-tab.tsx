"use client";

// The title manager's Seasons tab (Sonarr): Sonarr's own series page in one
// list — monitor or unmonitor each season (Sonarr sets its episodes to match)
// and each episode, search a season or an episode, or pick a release by hand
// for either. Episodes load per season on every expand
// (GET /api/admin/arr/title/episodes), and an open list is read again whenever
// the title is re-read with that season's header changed (a file deleted in
// the Files tab, a refresh or a search finishing). Air-date verdicts are judged
// against the server's time when the list was read, never a clock read here
// (guardrail 16).
//
// Rows are wrapping flex rows, not a fixed-width table: at phone width a
// table's actions sat off-screen.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Chip } from "@/components/ui/design";
import { AlertTriangle, ChevronDown, ChevronRight, Loader2, RefreshCw, Search, Download } from "@/components/icons";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import { episodeCode, queueFormatters } from "@/components/admin/queue-format";
import type { ArrTitle, TitleEpisode, TitleSeason } from "@/lib/arr-title";
import { seasonSignature, staleSeasons } from "@/lib/arr-title-ui";
import { arrApi, titleQuery, type TitleRef } from "./shared";

export type ReleaseScope = { seasonNumber: number } | { episodeId: number };

type EpisodeList = { loading: boolean; error: string; episodes: TitleEpisode[]; loadedAt: number };

// Sonarr's finale kinds, translated (a literal map — never a built key).
const FINALE_KEYS: Record<string, string> = {
  series: "adminArr.calendar.seriesFinale",
  season: "adminArr.calendar.seasonFinale",
  midseason: "adminArr.calendar.midseasonFinale",
};

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
  runCommand: (body: Record<string, unknown>, done: string) => Promise<void>;
  pickRelease: (scope: ReleaseScope, subtitle: string) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const fmt = useMemo(() => queueFormatters(locale), [locale]);
  const day = useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: "medium" }), [locale]);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
  const [lists, setLists] = useState<Record<number, EpisodeList>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  // Per season: only the newest read may write its list — expanding and then
  // flipping a season starts two reads, and a late stale answer must not win.
  const listSeq = useRef<Record<number, number>>({});
  // Per season: the newest read that answered. A read is in flight while it
  // trails listSeq.
  const doneSeq = useRef<Record<number, number>>({});
  // Per season: the header signature its open list was last brought up to date with.
  const seenSig = useRef(new Map<number, string>());
  const anime = title.seriesType === "anime";

  // Newest season first, specials last — Sonarr's own order.
  const seasons = [...title.seasons].sort((a, b) => (a.seasonNumber === 0 ? 1 : b.seasonNumber === 0 ? -1 : b.seasonNumber - a.seasonNumber));
  const seasonLabel = (n: number) => (n === 0 ? t("adminArr.seasons.specials") : t("adminArr.seasons.season", { number: n }));

  const loadEpisodes = useCallback(async (n: number) => {
    const seq = (listSeq.current[n] ?? 0) + 1;
    listSeq.current[n] = seq;
    setLists((l) => ({ ...l, [n]: { loading: true, error: "", episodes: l[n]?.episodes ?? [], loadedAt: l[n]?.loadedAt ?? 0 } }));
    const res = await arrApi<{ episodes: TitleEpisode[]; now: string }>(`/api/admin/arr/title/episodes?${titleQuery(titleRef, { season: n })}`, undefined, t("adminArr.seasons.episodesFailed"));
    if (listSeq.current[n] !== seq) return;
    doneSeq.current[n] = seq;
    setLists((l) => ({
      ...l,
      [n]: res.ok
        ? { loading: false, error: "", episodes: res.data.episodes, loadedAt: Date.parse(res.data.now) || 0 }
        // A failed re-read keeps the list it had.
        : { loading: false, error: res.error, episodes: l[n]?.episodes ?? [], loadedAt: l[n]?.loadedAt ?? 0 },
    }));
  }, [titleRef, t]);

  // The title was re-read behind this tab: an open list whose season header
  // changed is read again, or its rows would disagree with the header above
  // them (9/10 files over a row still reading "Downloaded"). A flip of this
  // tab's own marks its season seen first — it re-reads that list itself.
  useEffect(() => {
    for (const n of staleSeasons(seenSig.current, title.seasons)) {
      if (expanded.has(n) && lists[n]) void loadEpisodes(n);
    }
  }, [title.seasons, expanded, lists, loadEpisodes]);

  // A season flip's or episode flip's own answer: that season is up to date
  // as far as this tab is concerned.
  function markSeen(next: ArrTitle | null, n: number) {
    const s = next?.seasons.find((x) => x.seasonNumber === n);
    if (s) seenSig.current.set(n, seasonSignature(s));
  }

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
    setBusy(`season:${season.seasonNumber}`);
    setError("");
    const res = await arrApi<{ title: ArrTitle | null }>(
      "/api/admin/arr/title",
      { method: "PATCH", body: { service: titleRef.service, instance: titleRef.instance, id: titleRef.arrId, seasons: [{ seasonNumber: season.seasonNumber, monitored }] } },
      t("adminArr.settings.saveFailed"),
    );
    if (!res.ok) {
      setBusy(null);
      setError(res.error);
      return;
    }
    const n = season.seasonNumber;
    markSeen(res.data.title, n);
    onTitle(res.data.title);
    // Sonarr set the season's episodes to match; re-read an open list BEFORE
    // the switches come back — until it answers, its rows show the episodes'
    // old monitoring, and a flip made from them would race this read.
    if (expanded.has(n) && lists[n]) await loadEpisodes(n);
    setBusy(null);
  }

  async function setEpisodeMonitored(season: number, ep: TitleEpisode, monitored: boolean) {
    setBusy(`episode:${ep.id}`);
    setError("");
    const res = await arrApi<{ updated: number; title: ArrTitle | null }>(
      "/api/admin/arr/title/episodes",
      { method: "PATCH", body: { service: titleRef.service, instance: titleRef.instance, id: titleRef.arrId, episodeIds: [ep.id], monitored } },
      t("adminArr.settings.saveFailed"),
    );
    setBusy(null);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    // A read of this season still in flight was sent before the flip landed
    // and carries the old value: start a newer one — only the newest read
    // writes the list.
    if ((listSeq.current[season] ?? 0) !== (doneSeq.current[season] ?? 0)) void loadEpisodes(season);
    setLists((l) => {
      const cur = l[season];
      if (!cur) return l;
      return { ...l, [season]: { ...cur, episodes: cur.episodes.map((e) => (e.id === ep.id ? { ...e, monitored } : e)) } };
    });
    // The counts follow monitoring (unmonitoring the one missing aired episode
    // is what makes a series read complete) — show Sonarr's new ones.
    markSeen(res.data.title, season);
    onTitle(res.data.title);
  }

  async function command(key: string, body: Record<string, unknown>, done: string) {
    setBusy(key);
    await runCommand(body, done);
    setBusy(null);
  }

  function episodeChip(ep: TitleEpisode, loadedAt: number) {
    if (ep.hasFile) return <Chip tone="approved">{t("adminArr.status.downloaded")}</Chip>;
    const aired = ep.airDateUtc !== null && Date.parse(ep.airDateUtc) <= loadedAt;
    if (!aired) return <Chip>{t("adminArr.status.unaired")}</Chip>;
    // Sonarr never searches an unmonitored episode, or anything of an unmonitored series.
    if (!ep.monitored || !title.monitored) return <Chip>{t("adminArr.status.unmonitored")}</Chip>;
    return <Chip tone="declined">{t("adminArr.status.missing")}</Chip>;
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
        {seasons.map((s, i) => {
          const open = expanded.has(s.seasonNumber);
          const list = lists[s.seasonNumber];
          const complete = s.episodeCount > 0 && s.episodeFileCount >= s.episodeCount;
          const searchHint = !title.monitored || !s.monitored ? t("adminArr.seasons.searchUnmonitored") : t("adminArr.seasons.searchSeason");
          return (
            <li key={s.seasonNumber} style={i > 0 ? { borderTop: "1px solid var(--ds-border)" } : undefined}>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5">
                <button
                  type="button"
                  onClick={() => toggle(s.seasonNumber)}
                  aria-expanded={open}
                  className="flex min-w-[7rem] items-center gap-1.5 font-medium text-zinc-100 hover:text-zinc-100"
                >
                  {open ? <ChevronDown className="h-4 w-4 text-zinc-500" /> : <ChevronRight className="h-4 w-4 text-zinc-500" />}
                  {seasonLabel(s.seasonNumber)}
                </button>
                <Switch
                  size="sm"
                  checked={s.monitored}
                  loading={busy === `season:${s.seasonNumber}`}
                  disabled={busy !== null}
                  onCheckedChange={(v) => void setSeasonMonitored(s, v)}
                  aria-label={t("adminArr.seasons.monitorSeason", { season: seasonLabel(s.seasonNumber) })}
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
                    disabled={busy !== null}
                    title={searchHint}
                    aria-label={t("adminArr.seasons.searchSeasonAria", { season: seasonLabel(s.seasonNumber) })}
                    onClick={() => void command(`search:${s.seasonNumber}`, { action: "searchSeason", seasonNumber: s.seasonNumber }, t("adminArr.notice.seasonSearch", { season: seasonLabel(s.seasonNumber) }))}
                  >
                    {busy === `search:${s.seasonNumber}` ? <Loader2 className="animate-spin" /> : <Search />}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    disabled={busy !== null}
                    title={t("adminArr.actions.interactive")}
                    aria-label={t("adminArr.seasons.interactiveAria", { season: seasonLabel(s.seasonNumber) })}
                    onClick={() => pickRelease({ seasonNumber: s.seasonNumber }, seasonLabel(s.seasonNumber))}
                  >
                    <Download />
                  </Button>
                </span>
              </div>
              {open && (
                <div className="px-3 pb-3" style={{ background: "var(--ds-bg-1)" }}>
                  {!list || (list.loading && list.episodes.length === 0) ? (
                    <div className="flex items-center gap-2 py-3 text-xs text-zinc-500"><Loader2 className="h-4 w-4 animate-spin" /> {t("adminArr.common.loading")}</div>
                  ) : list.error && list.episodes.length === 0 ? (
                    <p role="alert" className="m-0 flex flex-wrap items-center gap-2 py-3 text-xs" style={{ color: "var(--ds-danger)" }}>
                      {list.error}
                      <Button variant="ghost" size="xs" onClick={() => void loadEpisodes(s.seasonNumber)}>
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
                        <li key={ep.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2" style={{ borderTop: "1px solid var(--ds-border)" }}>
                          <Switch
                            size="sm"
                            checked={ep.monitored}
                            loading={busy === `episode:${ep.id}`}
                            disabled={busy !== null}
                            onCheckedChange={(v) => void setEpisodeMonitored(s.seasonNumber, ep, v)}
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
                          {episodeChip(ep, list.loadedAt)}
                          <span className="flex gap-1">
                            <Button
                              variant="ghost"
                              size="icon-xs"
                              disabled={busy !== null}
                              title={t("adminArr.seasons.searchEpisode")}
                              aria-label={t("adminArr.seasons.searchEpisodeAria", { episode: episodeCode(ep) })}
                              onClick={() => void command(`ep:${ep.id}`, { action: "searchEpisodes", episodeIds: [ep.id] }, t("adminArr.notice.episodeSearch", { episode: episodeCode(ep) }))}
                            >
                              {busy === `ep:${ep.id}` ? <Loader2 className="animate-spin" /> : <Search />}
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon-xs"
                              disabled={busy !== null}
                              title={t("adminArr.actions.interactive")}
                              aria-label={t("adminArr.seasons.interactiveEpisodeAria", { episode: episodeCode(ep) })}
                              onClick={() => pickRelease({ episodeId: ep.id }, `${episodeCode(ep)} · ${ep.title}`)}
                            >
                              <Download />
                            </Button>
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
