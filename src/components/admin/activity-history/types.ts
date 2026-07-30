// Shared types for the admin history table (activity-history-table.tsx and
// the extracted pieces under this directory).

export interface HistoryRow {
  id: string;
  source: string;
  // Media-server instance slug (media-instances.ts). "" = the default/only
  // server, which is also what every row written before multi-server support
  // reads (`@default("")`), so the UI renders a badge for it only when
  // non-empty. Already on the wire: the ungrouped API path `include`s the whole
  // PlayHistory row and the grouped path selects `h.*`.
  serverInstance: string;
  title: string;
  tmdbId: number | null;
  mediaType: string | null;
  startedAt: string;
  stoppedAt: string | null;
  duration: number;
  playDuration: number;
  pausedDuration: number | null;
  watched: boolean;
  platform: string | null;
  player: string | null;
  device: string | null;
  ipAddress: string | null;
  playMethod: string | null;
  resolution: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  bitrate: number | null;
  container: string | null;
  videoDecision: string | null;
  audioDecision: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  episodeTitle: string | null;
  posterUrl: string | null;
  // Network metadata (Plex-only — Jellyfin leaves these null).
  location: string | null;
  bandwidth: number | null;
  secure: boolean | null;
  relayed: boolean | null;
  // Intro/credits markers (Plex-only). Offsets in milliseconds.
  introStartMs: number | null;
  introEndMs: number | null;
  creditsStartMs: number | null;
  creditsEndMs: number | null;
  // Resume-grouping anchor (see prisma/schema.prisma PlayHistory.referenceId).
  referenceId: string | null;
  // Resume-grouping aggregates. Populated by the grouped API path (default);
  // in ungrouped mode the API mirrors single-row defaults (segmentCount = 1,
  // totalPlayDuration = playDuration, chainId = referenceId ?? id) so the
  // UI can read these fields unconditionally.
  segmentCount?: number;
  chainId?: string;
  totalPlayDuration?: number;
  mediaServerUserId: string;
  mediaServerUser: {
    username: string;
    source: string;
    thumbUrl: string | null;
  };
}

export interface MediaServerUserOption {
  id: string;
  username: string;
  source: string;
}

export type SortField =
  | "startedAt"
  | "title"
  | "playDuration"
  | "duration"
  | "platform";
export type SortDir = "asc" | "desc";
