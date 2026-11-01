// Pure, zero-import rules for the playback context an issue carries: the
// reporter's most recent play of the reported title, snapshotted at filing time
// so an admin sees the likely cause (client, direct play vs transcode, codec,
// bitrate, why it transcoded) without asking. Reading the rows lives in
// issue-playback-context-data.ts.
//
// Rules:
//   - NEVER the IP address (or any network identifier) — the admin needs the
//     client and the decision, not where the reporter was.
//   - bitrate is normalized through the shared source-aware helper (guardrail
//     19a), never by magnitude.
//   - transcodeReason is stored as recorded; the reader translates it
//     (guardrail 19c).

import { bitrateToKbps } from "./bitrate";

export const PLAYBACK_CONTEXT_VERSION = 1;
/** Only a play this recent says anything about what the reporter just saw. */
export const PLAYBACK_CONTEXT_WINDOW_DAYS = 45;
/** Rows the loader reads; the picker chooses among them. */
export const PLAYBACK_CONTEXT_CANDIDATES = 25;

export interface PlayRow {
  source: string;
  startedAt: Date;
  stoppedAt: Date;
  seasonNumber: number | null;
  episodeNumber: number | null;
  platform: string | null;
  player: string | null;
  device: string | null;
  playMethod: string | null;
  videoDecision: string | null;
  audioDecision: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  resolution: string | null;
  container: string | null;
  bitrate: number | null;
  transcodeReason: string | null;
  location: string | null;
  relayed: boolean | null;
}

export interface PlaybackContext {
  v: typeof PLAYBACK_CONTEXT_VERSION;
  /** ISO time the play ended. */
  playedAt: string;
  source: string;
  /** The play matched the issue's season/episode (false = a play of the title). */
  exact: boolean;
  platform: string | null;
  player: string | null;
  device: string | null;
  playMethod: string | null;
  videoDecision: string | null;
  audioDecision: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  resolution: string | null;
  container: string | null;
  /** Delivered bitrate in kbps, source-normalized; null when unreported. */
  bitrateKbps: number | null;
  transcodeReason: string | null;
  /** "lan" | "wan" | "relay" */
  location: string | null;
  relayed: boolean | null;
}

export interface IssueScopeRef {
  scope: "FULL" | "SEASON" | "EPISODE";
  seasonNumber: number | null;
  episodeNumber: number | null;
}

function matchRank(row: PlayRow, s: IssueScopeRef): number {
  if (s.scope === "EPISODE") {
    if (row.seasonNumber === s.seasonNumber && row.episodeNumber === s.episodeNumber) return 2;
    if (row.seasonNumber === s.seasonNumber) return 1;
    return 0;
  }
  if (s.scope === "SEASON") return row.seasonNumber === s.seasonNumber ? 2 : 0;
  return 2; // FULL: any play of the title is as good as another
}

/**
 * The play to snapshot: the best scope match, newest first within a rank. A
 * scoped issue prefers the reported episode/season but falls back to any play of
 * the title (`exact: false`) rather than showing nothing. Rows outside the
 * window are ignored.
 */
export function pickPlay(
  rows: readonly PlayRow[],
  scope: IssueScopeRef,
  now: Date,
): { row: PlayRow; exact: boolean } | null {
  const cutoff = now.getTime() - PLAYBACK_CONTEXT_WINDOW_DAYS * 86_400_000;
  let best: { row: PlayRow; rank: number } | null = null;
  for (const row of rows) {
    if (row.stoppedAt.getTime() < cutoff) continue;
    const rank = matchRank(row, scope);
    if (
      !best ||
      rank > best.rank ||
      (rank === best.rank && row.stoppedAt.getTime() > best.row.stoppedAt.getTime())
    ) {
      best = { row, rank };
    }
  }
  if (!best) return null;
  return { row: best.row, exact: scope.scope === "FULL" || best.rank === 2 };
}

const clip = (v: string | null, max: number): string | null => (v ? v.slice(0, max) : null);

export function buildPlaybackContext(row: PlayRow, exact: boolean): PlaybackContext {
  const kbps = Math.round(bitrateToKbps(row.bitrate, row.source));
  return {
    v: PLAYBACK_CONTEXT_VERSION,
    playedAt: row.stoppedAt.toISOString(),
    source: row.source,
    exact,
    platform: clip(row.platform, 64),
    player: clip(row.player, 64),
    device: clip(row.device, 64),
    playMethod: clip(row.playMethod, 32),
    videoDecision: clip(row.videoDecision, 32),
    audioDecision: clip(row.audioDecision, 32),
    videoCodec: clip(row.videoCodec, 32),
    audioCodec: clip(row.audioCodec, 32),
    resolution: clip(row.resolution, 32),
    container: clip(row.container, 32),
    bitrateKbps: kbps > 0 ? kbps : null,
    transcodeReason: clip(row.transcodeReason, 300),
    location: clip(row.location, 16),
    relayed: row.relayed,
  };
}

const str = (v: unknown, max: number): string | null =>
  typeof v === "string" && v ? v.slice(0, max) : null;

/**
 * Reads a stored Json value back into a PlaybackContext, or null for anything
 * that is not a version-1 context. The column is Json, so a hand-edited or
 * future-version value must render as "nothing", never throw in a page.
 */
export function parsePlaybackContext(value: unknown): PlaybackContext | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  if (r.v !== PLAYBACK_CONTEXT_VERSION) return null;
  const playedAt = str(r.playedAt, 40);
  const source = str(r.source, 16);
  if (!playedAt || !source || Number.isNaN(Date.parse(playedAt))) return null;
  const kbps = typeof r.bitrateKbps === "number" && Number.isFinite(r.bitrateKbps) && r.bitrateKbps > 0 ? Math.round(r.bitrateKbps) : null;
  return {
    v: PLAYBACK_CONTEXT_VERSION,
    playedAt,
    source,
    exact: r.exact === true,
    platform: str(r.platform, 64),
    player: str(r.player, 64),
    device: str(r.device, 64),
    playMethod: str(r.playMethod, 32),
    videoDecision: str(r.videoDecision, 32),
    audioDecision: str(r.audioDecision, 32),
    videoCodec: str(r.videoCodec, 32),
    audioCodec: str(r.audioCodec, 32),
    resolution: str(r.resolution, 32),
    container: str(r.container, 32),
    bitrateKbps: kbps,
    transcodeReason: str(r.transcodeReason, 300),
    location: str(r.location, 16),
    relayed: typeof r.relayed === "boolean" ? r.relayed : null,
  };
}

/** "8.2 Mbps" / "640 kbps". */
export function formatBitrate(kbps: number): string {
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${kbps} kbps`;
}
