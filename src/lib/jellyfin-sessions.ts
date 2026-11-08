// What is playing on a Jellyfin server (the 5s play-history poller and the
// admin terminate read this), and the admin terminate itself.
import { safeFetchAdminConfigured } from "./safe-fetch";
import { trimServerBase } from "./server-url";
import { NO_REASON_REPORTED } from "./transcode-reasons";
import { check, v, type Infer } from "./validate";
import { loose, looseList, looseString, parseEach, stringRecord } from "./media-server-payload";
import { FETCH_TIMEOUT_MS, jellyfinAdminHeaders, jellyfinHeaders } from "./jellyfin-http";

export interface JellyfinSessionData {
  sessionId: string;
  playSessionId: string;
  state: "playing" | "paused" | "buffering";
  userId: string;
  userName: string;
  itemId: string;
  title: string;
  seriesId?: string;
  seriesName?: string;
  seasonNumber?: number;
  episodeNumber?: number;
  itemType: string;
  year?: number;
  durationTicks: number;
  positionTicks: number;
  providerIds?: Record<string, string>;
  playMethod?: string;
  client?: string;
  deviceName?: string;
  deviceId?: string;
  remoteEndPoint?: string;
  videoCodec?: string;
  audioCodec?: string;
  resolution?: string;
  container?: string;
  bitrate?: number;
  transcodeReason?: string;
}

// One /Sessions entry. Lenient fields (media-server-payload.ts): a wrong-typed
// field degrades to absent, so one odd field never hides a live session from
// the poller (whose absence sweep would then finalize it).
const MediaStreamSchema = v.object({
  Type: looseString(),
  Codec: looseString(),
  BitRate: loose(v.number()),
  Width: loose(v.number()),
  Height: loose(v.number()),
});
const JellyfinSessionSchema = v.object({
  Id: looseString(),
  PlaySessionId: looseString(),
  UserId: looseString(),
  UserName: looseString(),
  Client: looseString(),
  DeviceName: looseString(),
  DeviceId: looseString(),
  RemoteEndPoint: looseString(),
  NowPlayingItem: loose(v.object({
    Id: looseString(),
    Name: looseString(),
    SeriesId: looseString(),
    SeriesName: looseString(),
    ParentIndexNumber: loose(v.number()),
    IndexNumber: loose(v.number()),
    Type: looseString(),
    ProductionYear: loose(v.number()),
    RunTimeTicks: loose(v.number()),
    ProviderIds: loose(stringRecord),
    Container: looseString(),
    MediaStreams: looseList(MediaStreamSchema),
    // Container-level totals (every track plus overhead), one entry per version.
    // Jellyfin does not always populate this on /Sessions — sourceBitrateBps
    // falls back to summing MediaStreams when it is absent.
    MediaSources: looseList(v.object({ Id: looseString(), Bitrate: loose(v.number()) })),
  })),
  PlayState: loose(v.object({
    PositionTicks: loose(v.number()),
    IsPaused: loose(v.boolean()),
    PlayMethod: looseString(),
    // Which MediaSources entry is playing, for multi-version items.
    MediaSourceId: looseString(),
  })),
  TranscodingInfo: loose(v.object({
    VideoCodec: looseString(),
    AudioCodec: looseString(),
    Bitrate: loose(v.number()),
    Container: looseString(),
    IsVideoDirect: loose(v.boolean()),
    IsAudioDirect: loose(v.boolean()),
    TranscodeReasons: looseList(v.string()),
  })),
});
type JellyfinSessionRaw = Infer<typeof JellyfinSessionSchema>;
type NowPlaying = NonNullable<JellyfinSessionRaw["NowPlayingItem"]>;

// Jellyfin TranscodeReasons are PascalCase enum tokens
// ("AudioCodecNotSupported"). Render them sentence-case ("Audio codec not
// supported") — the phrases transcode-reasons.ts translates for the activity UI.
function humanizeJellyfinReasons(reasons: string[] | undefined): string | undefined {
  if (!reasons || reasons.length === 0) return undefined;
  const phrases = reasons.map((r) => {
    const words = r.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(" ");
    return words
      .map((w, i) => (i === 0 ? w : w.toLowerCase()))
      .join(" ");
  });
  return [...new Set(phrases)].join(", ");
}

// Total SOURCE bitrate (bps) of the media source actually playing.
//
// Only reached when there is no TranscodingInfo — i.e. DirectPlay, where the
// file is pushed as-is, so the source total IS the delivered bitrate and this
// feeds the activity Bandwidth stat directly.
//
// The previous fallback was `videoStream.BitRate`, the VIDEO track alone, which
// silently dropped the audio from every direct-played Jellyfin session: 128 kbps
// for stereo AAC, and up to ~4.5 Mbps for a TrueHD/DTS-HD MA track, where the
// undercount is larger than many whole streams.
//
// MediaSources[].Bitrate is the container total and is exactly what direct play
// transfers, so it wins when present. Jellyfin does not always populate
// MediaSources on /Sessions, hence the stream sum: video + the selected audio
// track, the pair the player is decoding. A file carrying several audio tracks
// direct-plays all of them, so that sum is a FLOOR — still far closer than video
// alone, and it can never over-report.
function sourceBitrateBps(np: NowPlaying, ps: JellyfinSessionRaw["PlayState"]): number | undefined {
  const sources = np.MediaSources;
  if (sources?.length) {
    const playing =
      (ps?.MediaSourceId ? sources.find((m) => m.Id === ps.MediaSourceId) : undefined) ??
      sources[0];
    if (typeof playing?.Bitrate === "number" && playing.Bitrate > 0) return playing.Bitrate;
  }

  const streams = np.MediaStreams;
  if (!streams?.length) return undefined;
  const video = streams.find((s) => s.Type === "Video")?.BitRate ?? 0;
  const audio = streams.find((s) => s.Type === "Audio")?.BitRate ?? 0;
  const total = video + audio;
  return total > 0 ? total : undefined;
}

/**
 * The resolution label of a video stream, by its WIDTH as well as its height:
 * a scope film is wide and short — 1920×800 is 1080p and 3840×1600 is 4K,
 * though their heights alone read "800p" and "1080p". The buckets are the
 * ones Plex reports (videoResolution), so the two servers' stats agree. A
 * stream under 720p in both dimensions keeps its literal height ("480p").
 */
export function jellyfinResolutionLabel(width: number | undefined, height: number | undefined): string | undefined {
  const w = width !== undefined && width > 0 ? width : 0;
  const h = height !== undefined && height > 0 ? height : 0;
  if (w >= 3200 || h >= 2160) return "4K";
  if (w >= 1800 || h >= 1080) return "1080p";
  if (w >= 1200 || h >= 720) return "720p";
  return h > 0 ? `${h}p` : undefined;
}

// Jellyfin's PlayState.PlayMethod can be stale; TranscodingInfo is the
// authoritative source. Don't default to "DirectPlay" when PlayMethod is absent
// — that mis-categorizes sessions in the activity stats. Fall through to
// whatever TranscodingInfo says, or leave it unknown (consumers tolerate that).
function playMethodOf(s: JellyfinSessionRaw): string | undefined {
  const ti = s.TranscodingInfo;
  const claimed = s.PlayState?.PlayMethod;
  if (!ti) return claimed;
  if (!ti.IsVideoDirect || !ti.IsAudioDirect) return "Transcode";
  return claimed === "DirectPlay" ? "DirectPlay" : "DirectStream";
}

function toSessionData(s: JellyfinSessionRaw & { NowPlayingItem: NowPlaying }): JellyfinSessionData {
  const np = s.NowPlayingItem;
  const ps = s.PlayState;
  const ti = s.TranscodingInfo;
  const videoStream = np.MediaStreams?.find((ms) => ms.Type === "Video");
  const audioStream = np.MediaStreams?.find((ms) => ms.Type === "Audio");
  const playMethod = playMethodOf(s);
  return {
    sessionId: s.Id ?? "",
    playSessionId: s.PlaySessionId ?? s.Id ?? "",
    state: ps?.IsPaused ? "paused" : "playing",
    userId: s.UserId ?? "",
    userName: s.UserName ?? "",
    itemId: np.Id ?? "",
    title: np.Type === "Episode" && np.SeriesName
      ? `${np.SeriesName} — ${np.Name ?? ""}`
      : np.Name ?? "",
    seriesId: np.SeriesId,
    seriesName: np.SeriesName,
    seasonNumber: np.ParentIndexNumber,
    episodeNumber: np.IndexNumber,
    itemType: np.Type ?? "Movie",
    year: np.ProductionYear,
    durationTicks: np.RunTimeTicks ?? 0,
    positionTicks: ps?.PositionTicks ?? 0,
    providerIds: np.ProviderIds,
    playMethod,
    client: s.Client,
    deviceName: s.DeviceName,
    deviceId: s.DeviceId,
    remoteEndPoint: s.RemoteEndPoint,
    videoCodec: ti?.VideoCodec ?? videoStream?.Codec,
    audioCodec: ti?.AudioCodec ?? audioStream?.Codec,
    resolution: jellyfinResolutionLabel(videoStream?.Width, videoStream?.Height),
    container: ti?.Container ?? np.Container,
    // Transcoding ⇒ TranscodingInfo.Bitrate is the OUTPUT bitrate, which is
    // what actually leaves the server. No TranscodingInfo ⇒ DirectPlay, where
    // the source total is the delivered bitrate. Both are "bytes on the
    // wire", so the Bandwidth stat means one thing across play methods.
    bitrate: ti?.Bitrate ?? sourceBitrateBps(np, ps),
    // No TranscodeReasons ⇒ say so. The old fallback, "Container not
    // supported", asserted a cause Jellyfin never reported.
    transcodeReason:
      playMethod === "Transcode"
        ? humanizeJellyfinReasons(ti?.TranscodeReasons) ?? NO_REASON_REPORTED
        : undefined,
  };
}

// Server-side /Sessions filter for the 5s poller. Jellyfin's idle reaper
// clears NowPlayingItem within ~5-10 min of a client going silent, so 960s can
// never hide a session the NowPlayingItem filter below would have kept — it
// only stops the server serializing every idle device the poller was
// discarding client-side anyway (same value jellyfin-web's dashboard uses).
const SESSIONS_ACTIVE_WITHIN_SECONDS = 960;

const SessionsBody = v.array(v.unknown());

export async function getJellyfinSessions(baseUrl: string, apiKey: string): Promise<JellyfinSessionData[]> {
  const url = `${trimServerBase(baseUrl)}/Sessions?activeWithinSeconds=${SESSIONS_ACTIVE_WITHIN_SECONDS}`;
  const res = await safeFetchAdminConfigured(url, {
    headers: jellyfinHeaders(apiKey),
    timeoutMs: FETCH_TIMEOUT_MS,
  });
  if (!res.ok) throw new Error(`Jellyfin sessions: ${res.status}`);
  // Anything but an array is a failed read, never "nothing is playing": an
  // empty answer would let the poller's absence sweep finalize live sessions.
  const body = check(SessionsBody, await res.json());
  if (!body.ok) throw new Error(`Jellyfin sessions: unexpected response (${body.error})`);
  return parseEach(JellyfinSessionSchema, body.value)
    .filter((s): s is JellyfinSessionRaw & { NowPlayingItem: NowPlaying } => s.NowPlayingItem !== undefined)
    .map(toSessionData);
}

// Tear down a Jellyfin playback by sending the "Stop" playstate command.
// Jellyfin addresses sessions by the session UUID (`Sessions[].Id`), NOT the
// PlaySessionId we persist on ActiveSession.sessionKey — the caller resolves
// sessionKey → the live session UUID via a /Sessions snapshot before calling.
// Jellyfin has no terminate-with-reason like Plex's, so when a reason is given
// we push a best-effort DisplayMessage command first; its failure must not
// block the Stop. Uses admin headers because session-control commands require
// elevation in newer Jellyfin versions (see jellyfinAdminHeaders).
export async function terminateJellyfinSession(
  baseUrl: string,
  apiKey: string,
  sessionId: string,
  reason?: string,
): Promise<{ ok: boolean; status: number }> {
  const base = trimServerBase(baseUrl);
  const id = encodeURIComponent(sessionId);

  // Best-effort DisplayMessage — fire WITHOUT awaiting so a client that doesn't
  // ack the General command can't stall the Stop behind a 30s timeout (the
  // caller's fetch has no timeout, so a stalled command shows as a hung button).
  // Short timeout: a message that takes >5s to deliver is pointless. The Stop
  // below is the one we await. Safe to float in a long-lived Node server.
  if (reason && reason.trim().length > 0) {
    void safeFetchAdminConfigured(`${base}/Sessions/${id}/Command`, {
      method: "POST",
      headers: jellyfinAdminHeaders(apiKey),
      body: JSON.stringify({
        Name: "DisplayMessage",
        Arguments: { Header: "Playback stopped", Text: reason.slice(0, 500), TimeoutMs: 5000 },
      }),
      timeoutMs: 5_000,
    }).catch(() => null);
  }

  const res = await safeFetchAdminConfigured(`${base}/Sessions/${id}/Playing/Stop`, {
    method: "POST",
    headers: jellyfinAdminHeaders(apiKey),
    timeoutMs: FETCH_TIMEOUT_MS,
  });
  return { ok: res.ok, status: res.status };
}
