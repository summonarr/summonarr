// Pure, zero-import rules for the "too many simultaneous streams" alert.
//
// An ALERT, never an enforcement: nothing here stops or kicks a stream. The
// admin decides what to do about someone sharing an account.
//
// One person is one owner key: the Summonarr account a media-server identity is
// linked to, else the identity itself — so the same person streaming from Plex
// AND Jellyfin counts together. Server admins (the owner's own accounts) are
// exempt: they routinely run several players.
//
// The alert fires on the TRANSITION from at-or-under the limit to over it
// (guardrail 7c's shape), and a per-owner cooldown keeps a stream that flaps
// across the limit from re-alerting every few seconds. State is the caller's
// (a processSingleton in stream-limit-data.ts); these functions are pure.
//
// Hysteresis, asymmetric on purpose:
//   - An owner ENTERS "over" only on sessions SEEN DURING THE CURRENT POLL TICK
//     (lastSeenAt at or after the tick's start). A session that ended keeps its
//     row for the 60s absence grace and is never re-stamped, so any age window
//     counted it: a viewer who stopped on the TV and resumed on the phone a few
//     seconds later was two streams. An age window also aged a healthy server's
//     rows while a slow sibling server finished its fetch.
//   - An owner LEAVES "over" only once the sessions seen within the hold window
//     (the absence grace, measured back from the tick's start) are at or under
//     the limit. A one-tick gap — a server fetch failing, a Jellyfin client
//     briefly clearing NowPlayingItem — must not read as "back under the limit",
//     or a continuous over-limit stretch re-alerts after every cooldown.

/** One alert per owner per cooldown, however often they flap across the limit. */
export const STREAM_ALERT_COOLDOWN_MS = 30 * 60_000;
export const MAX_STREAM_LIMIT = 50;

export interface StreamSession {
  id: string;
  mediaServerUserId: string;
  /** The Summonarr account the identity is linked to, if any. */
  userId: string | null;
  /** Display name of the identity (the server username). */
  username: string;
  isServerAdmin: boolean;
  lastSeenAt: Date;
  title: string;
  seasonNumber: number | null;
  episodeNumber: number | null;
}

export interface OwnerStreams {
  ownerKey: string;
  username: string;
  userId: string | null;
  /** Sessions a server reported THIS tick: the only count that can put the owner over. */
  count: number;
  /** Sessions seen within the hold window (this tick's included): what keeps them over. */
  heldCount: number;
  /** Up to MAX_TITLES of this tick's sessions, for the alert text. */
  titles: string[];
}

const MAX_TITLES = 5;

/** The limit setting: a whole number 1..50, anything else (0, blank, junk) is OFF. */
export function parseStreamLimit(raw: string | null | undefined): number {
  if (!raw || !/^\d+$/.test(raw.trim())) return 0;
  const n = parseInt(raw, 10);
  return n >= 1 && n <= MAX_STREAM_LIMIT ? n : 0;
}

export function ownerKeyOf(s: Pick<StreamSession, "userId" | "mediaServerUserId">): string {
  return s.userId ? `u:${s.userId}` : `m:${s.mediaServerUserId}`;
}

/**
 * `seenSince`: the poll tick's start — a row stamped since is live this tick.
 * `holdSince`: the start of the hold window (the tick's start minus the absence
 * grace) — a row stamped since still holds an owner who is already over.
 */
export function countStreamsByOwner(
  sessions: readonly StreamSession[],
  seenSince: Date,
  holdSince: Date,
): Map<string, OwnerStreams> {
  const out = new Map<string, OwnerStreams>();
  for (const s of sessions) {
    if (s.isServerAdmin) continue;
    const seenAt = s.lastSeenAt.getTime();
    if (seenAt < holdSince.getTime()) continue;
    const key = ownerKeyOf(s);
    let e = out.get(key);
    if (!e) {
      e = { ownerKey: key, username: s.username, userId: s.userId, count: 0, heldCount: 0, titles: [] };
      out.set(key, e);
    }
    e.heldCount++;
    if (seenAt < seenSince.getTime()) continue;
    e.count++;
    if (e.titles.length < MAX_TITLES) e.titles.push(streamLabel(s));
  }
  return out;
}

function streamLabel(s: Pick<StreamSession, "title" | "seasonNumber" | "episodeNumber">): string {
  const title = s.title.slice(0, 80);
  if (s.seasonNumber != null && s.episodeNumber != null) {
    return `${title} S${String(s.seasonNumber).padStart(2, "0")}E${String(s.episodeNumber).padStart(2, "0")}`;
  }
  return title;
}

export interface StreamAlertState {
  /** Owners over the limit as of the last evaluation. */
  over: Set<string>;
  /** When each owner was last alerted (epoch ms). */
  alertedAt: Map<string, number>;
}

export interface StreamEvaluation {
  /** Owners that just went over the limit and are out of cooldown: alert these. */
  alert: OwnerStreams[];
  state: StreamAlertState;
}

/**
 * Pure transition step. `limit` 0 clears everything (the feature is off).
 * An owner enters `over` when this tick's `count` exceeds the limit, and stays
 * while `heldCount` does (see the hysteresis note at the top). An owner that is
 * over but was already over, or is inside the cooldown, is not re-alerted. An
 * owner whose held sessions dropped back to the limit leaves `over` (so the next
 * climb alerts again, once the cooldown allows).
 */
export function evaluateStreams(
  counts: ReadonlyMap<string, OwnerStreams>,
  limit: number,
  prev: StreamAlertState,
  nowMs: number,
): StreamEvaluation {
  if (limit <= 0) return { alert: [], state: { over: new Set(), alertedAt: new Map() } };
  const over = new Set<string>();
  const alertedAt = new Map(prev.alertedAt);
  const alert: OwnerStreams[] = [];
  for (const [key, owner] of counts) {
    const wasOver = prev.over.has(key);
    const isOver = owner.count > limit || (wasOver && owner.heldCount > limit);
    if (!isOver) continue;
    over.add(key);
    if (wasOver) continue;
    const last = alertedAt.get(key);
    if (last !== undefined && nowMs - last < STREAM_ALERT_COOLDOWN_MS) continue;
    alertedAt.set(key, nowMs);
    alert.push(owner);
  }
  // Forget cooldowns that have expired so the map cannot grow without bound.
  for (const [key, at] of alertedAt) {
    if (nowMs - at >= STREAM_ALERT_COOLDOWN_MS && !over.has(key)) alertedAt.delete(key);
  }
  return { alert, state: { over, alertedAt } };
}

export function streamAlertText(owner: Pick<OwnerStreams, "count" | "titles">, limit: number): string {
  return `${owner.count} streams at once (limit ${limit}): ${owner.titles.join(", ")}`.slice(0, 1000);
}
