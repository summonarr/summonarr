"use client";

// The Seasons tab's episode lists (seasons-tab.tsx): one per season, read on
// every expand (GET /api/admin/arr/title/episodes), and read again whenever the
// title is re-read with that season's header changed.
//
// Per season, only the NEWEST read may write its list — expanding and then
// flipping a season starts two reads, and a late stale answer must not win
// (`newest`); a read is in flight while it trails `answered`.
//
// "Instant, then live" (src/lib/arr-snapshot.ts): a season shown for the first
// time paints the list the server last read for it while its live read is out
// (episodeSnapshotMayPaint) — or after that read failed — never over rows
// already shown, never for a read a newer one superseded, never while a write
// of the tab is in flight (`writing`, read live).

import { useCallback, useEffect, useRef, useState } from "react";
import type { ArrTitle, TitleEpisode, TitleSeason } from "@/lib/arr-title";
import { seasonSignature, staleSeasons } from "@/lib/arr-title-ui";
import { withBasePath } from "@/lib/base-path";
import { readArrSnapshot } from "@/lib/client/arr-snapshot";
import { EPISODES_ANSWER } from "@/lib/client/arr-answers";
import { check } from "@/lib/validate";
import { arrApi, titleQuery, type TitleRef, type useTRef } from "./shared";
import { episodeSnapshotMayPaint } from "./snapshot-rules";

// `staleAt`: the rows are the snapshot read then (ISO), until a live answer lands.
export type EpisodeList = { loading: boolean; error: string; episodes: TitleEpisode[]; loadedAt: number; staleAt: string | null };

export function useEpisodeLists({ titleRef, seasons, expanded, writing, tRef }: {
  titleRef: TitleRef;
  /** The title's seasons as last read: an open list whose header changed is read again. */
  seasons: readonly TitleSeason[];
  expanded: ReadonlySet<number>;
  /** A write of the tab is in flight (read when a snapshot answers). Stable. */
  writing: () => boolean;
  tRef: ReturnType<typeof useTRef>;
}) {
  const [lists, setLists] = useState<Record<number, EpisodeList>>({});
  // Per season: the newest read started, and the newest read that answered.
  const listSeq = useRef<Record<number, number>>({});
  const doneSeq = useRef<Record<number, number>>({});
  // Per season: the header signature its open list was last brought up to date with.
  const seenSig = useRef(new Map<number, string>());
  // The lists as last rendered, for a snapshot answering later.
  const listsRef = useRef(lists);
  useEffect(() => {
    listsRef.current = lists;
  });

  const loadEpisodes = useCallback(async (n: number) => {
    const seq = (listSeq.current[n] ?? 0) + 1;
    listSeq.current[n] = seq;
    // One builder: the live read and its snapshot are this URL (the server keys on it).
    const path = `/api/admin/arr/title/episodes?${titleQuery(titleRef, { season: n })}`;
    setLists((l) => ({ ...l, [n]: { loading: true, error: "", episodes: l[n]?.episodes ?? [], loadedAt: l[n]?.loadedAt ?? 0, staleAt: l[n]?.staleAt ?? null } }));
    if (!listsRef.current[n]?.episodes.length) {
      void readArrSnapshot<unknown>(withBasePath(path)).then((snap) => {
        const parsed = snap ? check(EPISODES_ANSWER, snap.data) : null;
        if (!snap || !parsed?.ok) return;
        setLists((l) => {
          const cur = l[n];
          const paint = episodeSnapshotMayPaint({
            seq,
            newest: listSeq.current[n],
            answered: doneSeq.current[n],
            failed: (cur?.error ?? "") !== "",
            shown: cur?.episodes.length ?? 0,
            writing: writing(),
          });
          if (!paint) return l;
          return { ...l, [n]: { loading: cur?.loading ?? true, error: cur?.error ?? "", episodes: parsed.value.episodes, loadedAt: Date.parse(parsed.value.now) || 0, staleAt: snap.at } };
        });
      });
    }
    const res = await arrApi(path, { schema: EPISODES_ANSWER }, tRef.current("adminArr.seasons.episodesFailed"));
    if (listSeq.current[n] !== seq) return;
    doneSeq.current[n] = seq;
    setLists((l) => ({
      ...l,
      [n]: res.ok
        ? { loading: false, error: "", episodes: res.data.episodes, loadedAt: Date.parse(res.data.now) || 0, staleAt: null }
        // A failed re-read keeps the list it had (a snapshot stays marked as one).
        : { loading: false, error: res.error, episodes: l[n]?.episodes ?? [], loadedAt: l[n]?.loadedAt ?? 0, staleAt: l[n]?.staleAt ?? null },
    }));
  }, [titleRef, writing, tRef]);

  // The title was re-read behind this tab: an open list whose season header
  // changed is read again, or its rows would disagree with the header above
  // them (9/10 files over a row still reading "Downloaded"). Once per seasons
  // array — not again on every list or expand change. A flip of this tab's
  // own marks its season seen first — it re-reads that list itself.
  const checkedSeasons = useRef<readonly TitleSeason[] | null>(null);
  useEffect(() => {
    if (checkedSeasons.current === seasons) return;
    checkedSeasons.current = seasons;
    for (const n of staleSeasons(seenSig.current, seasons)) {
      if (expanded.has(n) && lists[n]) void loadEpisodes(n);
    }
  }, [seasons, expanded, lists, loadEpisodes]);

  return {
    lists,
    loadEpisodes,
    /** A flip's own answer: that season is up to date as far as this tab is concerned. */
    markSeen(next: ArrTitle | null, n: number) {
      const s = next?.seasons.find((x) => x.seasonNumber === n);
      if (s) seenSig.current.set(n, seasonSignature(s));
    },
    /** A read of the season is still out (sent before a flip landed). */
    readInFlight: (n: number) => (listSeq.current[n] ?? 0) !== (doneSeq.current[n] ?? 0),
    /** An episode flip's own answer, shown at once in its open list. */
    setEpisodeMonitored(n: number, id: number, monitored: boolean) {
      setLists((l) => {
        const cur = l[n];
        if (!cur) return l;
        return { ...l, [n]: { ...cur, episodes: cur.episodes.map((e) => (e.id === id ? { ...e, monitored } : e)) } };
      });
    },
  };
}
