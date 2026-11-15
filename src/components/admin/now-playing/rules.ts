// The Now playing grid's rules, without React (tests/now-playing-rules.test.mts).

import { parseActiveSessionId, type MediaServerService } from "@/lib/media-instances";
import { bitrateToKbps } from "@/lib/bitrate";
import { toActivityMediaType } from "@/lib/activity-title-resolve";
import type { Translator } from "@/lib/i18n/translate";
import type { FetchJsonResult } from "@/lib/client/fetch-json";

const TERMINATE_ENDPOINTS: Record<MediaServerService, string> = {
  plex: "/api/admin/play-history/terminate-session",
  jellyfin: "/api/admin/play-history/terminate-jellyfin-session",
};

export interface TerminateTarget {
  endpoint: string;
  sessionKey: string;
  // "" for the default server.
  serverInstance: string;
}

// ActiveSession.id is "<source>:<sessionKey>" for the default instance, or
// "<source>:<instance>:<sessionKey>" for a named one (see activeSessionId in
// media-instances.ts). Both sources need the real parse — a naive prefix-strip
// on a named instance's session would send the instance slug as part of the
// sessionKey and the server would 404 it (and resolve against the wrong
// server's snapshot). Null for a source that can't be stopped from here.
export function terminateTargetFor(sessionId: string): TerminateTarget | null {
  const { source, sessionKey, serverInstance } = parseActiveSessionId(sessionId);
  if (source !== "plex" && source !== "jellyfin") return null;
  return { endpoint: TERMINATE_ENDPOINTS[source], sessionKey, serverInstance };
}

// The credits chip's range: `end` null reads "runs to the end" (start+). A
// marker reaching the last second of a title whose length is known runs to the
// end; with no end marker the range ends at the title's length, or is open
// when that is unknown too (a duration of 0 used to read every credits marker
// as running to the end, and an unknown end as ending at 0:00).
export function creditsRange(
  startMs: number,
  endMs: number | null,
  durationMs: number,
): { start: number; end: number | null } {
  if (endMs != null) {
    if (durationMs > 0 && endMs >= durationMs - 1000) return { start: startMs, end: null };
    return { start: startMs, end: endMs };
  }
  return { start: startMs, end: durationMs > 0 ? durationMs : null };
}

// What the Network cell has to show. A Plex Relay session usually reports
// both location "relay" and relayed=true; the location badge already says
// relay then. `empty` (nothing to show) renders the "—" placeholder — Plex
// commonly sends relayed=false with nothing else, which used to leave the cell
// blank.
export function networkSignals(s: {
  location: string | null;
  secure: boolean | null;
  relayed: boolean | null;
}): { location: string | null; relay: boolean; secure: boolean | null; empty: boolean } {
  const location = s.location || null;
  const relay = !!s.relayed && s.location !== "relay";
  const secure = s.secure ?? null;
  return { location, relay, secure, empty: location === null && !relay && secure === null };
}

// The fields mergeLiveSessions reads.
export interface LiveSessionIdentity {
  id: string;
  source: string;
  tmdbId: number | null;
  mediaType: string | null;
  posterUrl: string | null;
}

// The grid after an `activity:sessions` push: the pushed sessions that pass
// the page's Source/Type filters, each keeping what the server render worked
// out and the push can't carry. The push is built from the raw ActiveSession
// rows, so a session the page matched by TITLE (a match it never stores) comes
// back with no tmdbId — and lost its media link, and possibly its type, on the
// first push. That identity is kept as a pair while the push has none, and the
// poster rides along the same way. A push that does carry a tmdbId wins.
export function mergeLiveSessions<S extends LiveSessionIdentity>(
  prev: readonly S[],
  incoming: readonly S[],
  filter: { source?: string; mediaType?: string },
): S[] {
  const prevById = new Map(prev.map((s) => [s.id, s]));
  const out: S[] = [];
  for (const s of incoming) {
    if (filter.source && s.source !== filter.source) continue;
    if (filter.mediaType && (s.mediaType ?? "").toUpperCase() !== filter.mediaType.toUpperCase()) continue;
    const before = prevById.get(s.id);
    const keepIdentity = s.tmdbId == null && before?.tmdbId != null;
    out.push({
      ...s,
      tmdbId: keepIdentity ? before.tmdbId : s.tmdbId,
      // The session's own known type wins over the earlier resolution's, as
      // on the page (activity-title-resolve).
      mediaType: keepIdentity ? toActivityMediaType(s.mediaType) ?? before.mediaType : s.mediaType,
      posterUrl: s.posterUrl ?? before?.posterUrl ?? null,
    });
  }
  return out;
}

// The section's subtitle: how many streams, the Plex/Jellyfin split when both
// have some, and the combined bitrate (normalized per source, guardrail 19a).
export function nowPlayingSubtitle(
  sessions: readonly { source: string; bitrate: number | null }[],
  t: Translator,
  locale: string,
): string {
  if (sessions.length === 0) return t("adminActivity.nowPlaying.noActiveLower");
  const plex = sessions.filter((s) => s.source === "plex").length;
  const jellyfin = sessions.length - plex;
  const totalMbps = sessions.reduce((sum, s) => sum + bitrateToKbps(s.bitrate, s.source), 0) / 1000;
  const parts = [t("adminActivity.nowPlaying.activeCount", { count: sessions.length })];
  if (plex > 0 && jellyfin > 0) parts.push(t("adminActivity.nowPlaying.sourceSplit", { plex, jellyfin }));
  if (totalMbps > 0) {
    parts.push(
      t("adminActivity.nowPlaying.combined", {
        mbps: totalMbps.toLocaleString(locale, { maximumFractionDigits: 1 }),
      }),
    );
  }
  return parts.join(" · ");
}

// What a terminate request's answer means for the dialog. "requested" closes
// it and marks the card; "ignore" is a dropped request. An error shows the
// route's own reason (fetchJson's `error`, its fallback when the route gave
// none), "unknownError" when the body wasn't JSON, and the translated
// no-answer copy when nothing came back — never the browser's own English,
// which `log` carries to the console instead.
export function terminateOutcome(
  res: FetchJsonResult<unknown>,
  t: Translator,
): { kind: "requested" } | { kind: "ignore" } | { kind: "error"; message: string; log?: string } {
  if (res.ok) return { kind: "requested" };
  if (res.kind === "aborted") return { kind: "ignore" };
  if (res.kind === "http") {
    return { kind: "error", message: res.body === null ? t("adminActivity.terminate.unknownError") : res.error };
  }
  if (res.kind === "invalid") return { kind: "error", message: res.error };
  return { kind: "error", message: t("adminActivity.terminate.networkError"), log: `${res.kind}: ${res.detail}` };
}
