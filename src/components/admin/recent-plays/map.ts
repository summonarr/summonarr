// The overview's Recent plays rows: their shape, the one mapping into it, and
// how a refreshed or further page joins the list. No React and no "use client"
// — the server page seeds page 1 through `toRecentPlay`, and the card maps
// "Load more" pages through the same function, so the two can't drift apart
// (tests/recent-plays-map.test.mts).

import type { HistoryRow } from "@/components/admin/activity-history/types";

// The play-history fields the table and its detail row read: a play as
// /api/play-history answers it, minus what the card never shows (the chain
// aggregates, network and markers, the poster), with the user flattened.
type RecentPlayFields =
  | "id"
  | "source"
  | "serverInstance"
  | "title"
  | "tmdbId"
  | "mediaType"
  | "startedAt"
  | "stoppedAt"
  | "duration"
  | "playDuration"
  | "pausedDuration"
  | "watched"
  | "platform"
  | "player"
  | "device"
  | "ipAddress"
  | "playMethod"
  | "resolution"
  | "videoCodec"
  | "audioCodec"
  | "bitrate"
  | "container"
  | "videoDecision"
  | "audioDecision"
  | "seasonNumber"
  | "episodeNumber"
  | "episodeTitle"
  | "mediaServerUserId";

export type RecentPlay = Pick<HistoryRow, RecentPlayFields> & {
  username: string;
  userSource: string;
  userThumb: string | null;
};

// What `toRecentPlay` reads: a PlayHistory row with its user, either straight
// from Prisma (Dates) or from the API (ISO strings).
export type RecentPlaySource = Omit<Pick<HistoryRow, RecentPlayFields>, "startedAt" | "stoppedAt"> & {
  startedAt: Date | string;
  stoppedAt: Date | string | null;
  mediaServerUser: { username: string; source: string; thumbUrl: string | null } | null;
};

const iso = (value: Date | string): string => (typeof value === "string" ? value : value.toISOString());

// Picks the card's fields — never a spread, so nothing else a row carries
// (session keys, transcode reasons) reaches the browser. `unknownUser` names a
// play whose user didn't come back.
export function toRecentPlay(p: RecentPlaySource, unknownUser = ""): RecentPlay {
  return {
    id: p.id,
    source: p.source,
    // Which media server the play came from. "" for the default/only server
    // (and for every row written before multi-server support) — the table
    // badges it only when non-empty.
    serverInstance: p.serverInstance,
    title: p.title,
    tmdbId: p.tmdbId,
    mediaType: p.mediaType,
    startedAt: iso(p.startedAt),
    stoppedAt: p.stoppedAt === null ? null : iso(p.stoppedAt),
    duration: p.duration,
    playDuration: p.playDuration,
    pausedDuration: p.pausedDuration,
    watched: p.watched,
    platform: p.platform,
    player: p.player,
    device: p.device,
    ipAddress: p.ipAddress,
    playMethod: p.playMethod,
    resolution: p.resolution,
    videoCodec: p.videoCodec,
    audioCodec: p.audioCodec,
    bitrate: p.bitrate,
    container: p.container,
    videoDecision: p.videoDecision,
    audioDecision: p.audioDecision,
    seasonNumber: p.seasonNumber,
    episodeNumber: p.episodeNumber,
    episodeTitle: p.episodeTitle,
    mediaServerUserId: p.mediaServerUserId,
    username: p.mediaServerUser?.username ?? unknownUser,
    userSource: p.mediaServerUser?.source ?? "",
    userThumb: p.mediaServerUser?.thumbUrl ?? null,
  };
}

// The server's own order: startedAt desc, then id desc.
function newestFirst(a: RecentPlay, b: RecentPlay): number {
  // By instant, not by text: a string with an offset or without milliseconds
  // would otherwise sort wrong. Unparseable text falls back to the text order.
  const ta = Date.parse(a.startedAt);
  const tb = Date.parse(b.startedAt);
  if (Number.isFinite(ta) && Number.isFinite(tb)) {
    if (ta !== tb) return ta < tb ? 1 : -1;
  } else if (a.startedAt !== b.startedAt) {
    return a.startedAt < b.startedAt ? 1 : -1;
  }
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

// A live refresh's fresh page 1, while the card shows more than one page:
// replacing the list would throw away the rows loaded with "Load more", so the
// plays not already listed are merged in, in the server's order. Nothing new
// keeps the same list (no re-render).
export function mergeRefreshedPlays(prev: RecentPlay[], fresh: readonly RecentPlay[]): RecentPlay[] {
  const seen = new Set(prev.map((p) => p.id));
  const added = fresh.filter((p) => !seen.has(p.id));
  if (added.length === 0) return prev;
  return [...added, ...prev].sort(newestFirst);
}

// A "Load more" page joins the end, minus rows already listed. Pages are
// counted by position in a newest-first list, so a play that finishes between
// loads pushes everything down one and the next page repeats a row; a
// duplicate would break React keys and make one click expand both copies.
export function appendPlays(prev: readonly RecentPlay[], page: readonly RecentPlay[]): RecentPlay[] {
  const seen = new Set(prev.map((p) => p.id));
  return [...prev, ...page.filter((p) => !seen.has(p.id))];
}
