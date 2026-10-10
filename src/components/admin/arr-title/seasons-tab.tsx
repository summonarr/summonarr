"use client";

// The title manager's Seasons tab (Sonarr): Sonarr's own series page in one
// list — monitor or unmonitor each season (Sonarr sets its episodes to match)
// and each episode, search a season or an episode, or pick a release by hand
// for either. Episodes load per season on expand
// (GET /api/admin/arr/title/episodes). Air-date verdicts are judged against
// the server's time when the list was read, never a clock read here (guardrail 16).

import { Fragment, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Chip } from "@/components/ui/design";
import { AlertTriangle, ChevronDown, ChevronRight, Loader2, Search, Download } from "@/components/icons";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import { episodeCode, queueFormatters } from "@/components/admin/queue-format";
import type { ArrTitle, TitleEpisode, TitleSeason } from "@/lib/arr-title";
import { arrApi, titleQuery, type TitleRef } from "./shared";

export type ReleaseScope = { seasonNumber: number } | { episodeId: number };

type EpisodeList = { loading: boolean; error: string; episodes: TitleEpisode[]; loadedAt: number };

export function SeasonsTab({
  titleRef,
  title,
  onTitle,
  runCommand,
  pickRelease,
}: {
  titleRef: TitleRef;
  title: ArrTitle;
  /** The series as Sonarr has it after a season flip. */
  onTitle: (title: ArrTitle) => void;
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

  // Newest season first, specials last — Sonarr's own order.
  const seasons = [...title.seasons].sort((a, b) => (a.seasonNumber === 0 ? 1 : b.seasonNumber === 0 ? -1 : b.seasonNumber - a.seasonNumber));
  const seasonLabel = (n: number) => (n === 0 ? t("adminArr.seasons.specials") : t("adminArr.seasons.season", { number: n }));

  async function loadEpisodes(n: number) {
    setLists((l) => ({ ...l, [n]: { loading: true, error: "", episodes: l[n]?.episodes ?? [], loadedAt: l[n]?.loadedAt ?? 0 } }));
    const res = await arrApi<{ episodes: TitleEpisode[]; now: string }>(`/api/admin/arr/title/episodes?${titleQuery(titleRef, { season: n })}`, undefined, t("adminArr.seasons.episodesFailed"));
    setLists((l) => ({
      ...l,
      [n]: res.ok
        ? { loading: false, error: "", episodes: res.data.episodes, loadedAt: Date.parse(res.data.now) || 0 }
        : { loading: false, error: res.error, episodes: [], loadedAt: 0 },
    }));
  }

  function toggle(n: number) {
    const opening = !expanded.has(n);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (opening) next.add(n);
      else next.delete(n);
      return next;
    });
    if (opening && !lists[n]) void loadEpisodes(n);
  }

  async function setSeasonMonitored(season: TitleSeason, monitored: boolean) {
    setBusy(`season:${season.seasonNumber}`);
    setError("");
    const res = await arrApi<{ title: ArrTitle }>(
      "/api/admin/arr/title",
      { method: "PATCH", body: { service: titleRef.service, instance: titleRef.instance, id: titleRef.arrId, seasons: [{ seasonNumber: season.seasonNumber, monitored }] } },
      t("adminArr.settings.saveFailed"),
    );
    setBusy(null);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    onTitle(res.data.title);
    // Sonarr set the season's episodes to match; re-read an open list.
    if (lists[season.seasonNumber]) void loadEpisodes(season.seasonNumber);
  }

  async function setEpisodeMonitored(season: number, ep: TitleEpisode, monitored: boolean) {
    setBusy(`episode:${ep.id}`);
    setError("");
    const res = await arrApi<{ updated: number }>(
      "/api/admin/arr/title/episodes",
      { method: "PATCH", body: { service: titleRef.service, instance: titleRef.instance, id: titleRef.arrId, episodeIds: [ep.id], monitored } },
      t("adminArr.settings.saveFailed"),
    );
    setBusy(null);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setLists((l) => {
      const cur = l[season];
      if (!cur) return l;
      return { ...l, [season]: { ...cur, episodes: cur.episodes.map((e) => (e.id === ep.id ? { ...e, monitored } : e)) } };
    });
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
    if (!ep.monitored) return <Chip>{t("adminArr.status.unmonitored")}</Chip>;
    return <Chip tone="declined">{t("adminArr.status.missing")}</Chip>;
  }

  if (seasons.length === 0) return <p className="m-0 text-sm text-zinc-500">{t("adminArr.seasons.none")}</p>;

  return (
    <div className="grid gap-3">
      {error && (
        <p role="alert" className="m-0 flex items-center gap-1.5 text-xs" style={{ color: "var(--ds-danger)" }}>
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> {error}
        </p>
      )}
      <div className="overflow-x-auto rounded-lg" style={{ border: "1px solid var(--ds-border)" }}>
        <table className="w-full text-sm" style={{ minWidth: 560 }}>
          <tbody>
            {seasons.map((s, i) => {
              const open = expanded.has(s.seasonNumber);
              const list = lists[s.seasonNumber];
              const complete = s.episodeCount > 0 && s.episodeFileCount >= s.episodeCount;
              return (
                <Fragment key={s.seasonNumber}>
                  <tr style={i > 0 ? { borderTop: "1px solid var(--ds-border)" } : undefined}>
                    <td className="px-3 py-2.5 align-middle">
                      <button
                        type="button"
                        onClick={() => toggle(s.seasonNumber)}
                        aria-expanded={open}
                        className="flex items-center gap-1.5 font-medium text-zinc-100 hover:text-zinc-100"
                      >
                        {open ? <ChevronDown className="h-4 w-4 text-zinc-500" /> : <ChevronRight className="h-4 w-4 text-zinc-500" />}
                        {seasonLabel(s.seasonNumber)}
                      </button>
                    </td>
                    <td className="px-3 py-2.5 align-middle">
                      <Switch
                        size="sm"
                        checked={s.monitored}
                        loading={busy === `season:${s.seasonNumber}`}
                        disabled={busy !== null}
                        onCheckedChange={(v) => void setSeasonMonitored(s, v)}
                        aria-label={t("adminArr.seasons.monitorSeason", { season: seasonLabel(s.seasonNumber) })}
                      />
                    </td>
                    <td className="px-3 py-2.5 align-middle whitespace-nowrap">
                      <Chip tone={complete ? "approved" : s.episodeFileCount > 0 ? "pending" : "neutral"}>
                        {t("adminArr.seasons.files", { have: s.episodeFileCount, count: s.episodeCount })}
                      </Chip>
                      {s.totalEpisodeCount > s.episodeCount && (
                        <span className="ml-2 text-xs text-zinc-500">{t("adminArr.seasons.total", { count: s.totalEpisodeCount })}</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 align-middle text-xs text-zinc-500 whitespace-nowrap">
                      {s.sizeOnDisk > 0 ? fmt.size(s.sizeOnDisk) : ""}
                      {s.nextAiring && <span className="ml-2">{t("adminArr.seasons.nextAiring", { date: day.format(Date.parse(s.nextAiring)) })}</span>}
                    </td>
                    <td className="px-3 py-2.5 align-middle">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          disabled={busy !== null}
                          title={t("adminArr.seasons.searchSeason")}
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
                      </div>
                    </td>
                  </tr>
                  {open && (
                    <tr>
                      <td colSpan={5} className="px-3 pb-3" style={{ background: "var(--ds-bg-1)" }}>
                        {!list || (list.loading && list.episodes.length === 0) ? (
                          <div className="flex items-center gap-2 py-3 text-xs text-zinc-500"><Loader2 className="h-4 w-4 animate-spin" /> {t("adminArr.common.loading")}</div>
                        ) : list.error ? (
                          <p role="alert" className="m-0 py-3 text-xs" style={{ color: "var(--ds-danger)" }}>{list.error}</p>
                        ) : list.episodes.length === 0 ? (
                          <p className="m-0 py-3 text-xs text-zinc-500">{t("adminArr.seasons.noEpisodes")}</p>
                        ) : (
                          <ul className="m-0 grid list-none gap-0 p-0">
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
                                <span className="ds-mono text-xs text-zinc-500">{episodeCode(ep)}</span>
                                <span className="min-w-0 flex-1 truncate text-sm text-zinc-200" title={ep.title}>{ep.title || "—"}</span>
                                <span className="text-xs text-zinc-500">{ep.airDateUtc ? day.format(Date.parse(ep.airDateUtc)) : t("adminArr.seasons.tba")}</span>
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
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
