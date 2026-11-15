// What is playing on a Plex server (the 5s play-history poller and the SSE
// bootstrap read this), the intro/credits markers stamped on a session at its
// start, and the admin terminate.
import { check, v, type Infer } from "./validate";
import {
  NO_REASON_REPORTED,
  PLEX_AUDIO_TRANSCODED,
  PLEX_SUBTITLE_BURN_IN,
  PLEX_VIDEO_TRANSCODED,
} from "./transcode-reasons";
import { idKey, loose, looseList, looseString, parseEach } from "./media-server-payload";
import { plexFetch, plexUrl, readPlexContainer } from "./plex-http";

export interface PlexSessionData {
  sessionKey: string;
  // Session.id — the long GUID Plex assigns per playback. Distinct from the
  // short sessionKey; the /status/sessions/terminate endpoint addresses
  // sessions by this GUID, not the sessionKey.
  sessionId?: string;
  state: "playing" | "paused" | "buffering";
  accountId: string;
  accountName: string;
  accountThumb: string;
  ratingKey: string;
  grandparentRatingKey?: string;
  title: string;
  grandparentTitle?: string;
  parentIndex?: number;
  index?: number;
  type: string;
  year?: string;
  duration: number;
  viewOffset: number;
  Guid?: Array<{ id?: string }>;
  platform?: string;
  player?: string;
  device?: string;
  address?: string;
  // Server-observed public address of the client's connection — Player.address
  // is the client's SELF-reported address, which for WAN sessions is routinely
  // a private/loopback value. Relayed sessions report 127.0.0.1 here (the
  // local relay endpoint), so consumers must treat loopback as "no value".
  remotePublicAddress?: string;
  playMethod?: string;
  videoCodec?: string;
  audioCodec?: string;
  resolution?: string;
  bitrate?: number;
  videoDecision?: string;
  audioDecision?: string;
  container?: string;
  transcodeReason?: string;
  // Network metadata. Session sub-object provides bandwidth (kbps) and
  // location ("lan" | "wan" | "relay"); Player sub-object exposes secure
  // ("0"/"1") and relayed ("0"/"1") to describe the client's connection.
  location?: "lan" | "wan" | "relay";
  bandwidth?: number;
  secure?: boolean;
  relayed?: boolean;
}

// Plex encodes several Player/Media flags as "0"/"1" strings on most clients
// but some newer Plex builds emit booleans.
const flag = () => loose(v.union(v.string(), v.boolean()));

// One /status/sessions entry. Every field lenient (media-server-payload.ts): a
// wrong-typed field degrades to absent, so one odd field never hides a live
// session from the poller (whose absence sweep would then finalize it).
//
// `selected` marks which Media version / Part / Stream is ACTUALLY playing —
// /status/sessions lists every version of a multi-version item and every
// stream of the playing part.
const PlexSessionSchema = v.object({
  sessionKey: loose(idKey),
  Player: loose(v.object({
    state: looseString(),
    title: looseString(),
    device: looseString(),
    product: looseString(),
    platform: looseString(),
    address: looseString(),
    secure: flag(),
    relayed: flag(),
    remotePublicAddress: looseString(),
  })),
  User: loose(v.object({ id: loose(idKey), title: looseString(), thumb: looseString() })),
  ratingKey: loose(idKey),
  grandparentRatingKey: loose(idKey),
  title: looseString(),
  grandparentTitle: looseString(),
  parentIndex: loose(v.number()),
  index: loose(v.number()),
  type: looseString(),
  year: loose(v.union(v.number(), v.string())),
  duration: loose(v.number()),
  viewOffset: loose(v.number()),
  Guid: looseList(v.object({ id: looseString() })),
  Media: looseList(v.object({
    container: looseString(),
    bitrate: loose(v.number()),
    videoResolution: looseString(),
    selected: flag(),
    Part: looseList(v.object({
      selected: flag(),
      Stream: looseList(v.object({ streamType: loose(v.number()), codec: looseString(), decision: looseString(), selected: flag() })),
    })),
  })),
  Session: loose(v.object({ id: looseString(), bandwidth: loose(v.number()), location: looseString() })),
  TranscodeSession: loose(v.object({ videoDecision: looseString(), audioDecision: looseString() })),
});
type PlexSessionRaw = Infer<typeof PlexSessionSchema>;

function toBool(value: string | boolean | undefined): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  return undefined;
}

// Derive a recognizable client/device name for the activity "Device" label and
// top-devices stats. Player.product is the canonical Plex client name ("Plex for
// Apple TV", "Plex for Roku", "Plex Web"); stripping the "Plex for "/"Plex "
// prefix yields the friendly form the user expects ("Apple TV", "Roku", "Web").
// Fall back to the device attribute, then the client title — never the
// machineIdentifier GUID.
function friendlyPlexDevice(
  player?: { product?: string; device?: string; title?: string },
): string | undefined {
  const product = player?.product?.trim();
  if (product) {
    const stripped = product.replace(/^Plex for /i, "").replace(/^Plex /i, "").trim();
    return stripped.length > 0 ? stripped : product;
  }
  return player?.device ?? player?.title ?? undefined;
}

// Coerced to a safe non-negative integer at the source: BigInt() throws a
// RangeError on a fractional value, and the poller converts both fields
// inside a per-instance Promise.all — one malformed session would reject the
// whole batch and starve that instance's absence sweep every tick. (The SSE
// writer floors the same fields in applyLiveStateUpdate.)
function wholeMs(value: number | undefined): number {
  return value !== undefined && value > 0 ? Math.floor(value) : 0;
}

// The streams actually playing: the `selected` Media/Part/Stream — a
// multi-version item (1080p + 4K files, multiple audio tracks) lists ALL of
// them and [0]/first-of-type is routinely the wrong one; PMS marks what is
// actually playing. Fixtures without the attribute fall back to the first.
function playingStreams(s: PlexSessionRaw) {
  const media = s.Media?.find((m) => toBool(m.selected)) ?? s.Media?.[0];
  const part = media?.Part?.find((p) => toBool(p.selected)) ?? media?.Part?.[0];
  const streamOfType = (streamType: number) =>
    part?.Stream?.find((st) => st.streamType === streamType && toBool(st.selected)) ??
    part?.Stream?.find((st) => st.streamType === streamType);
  return { media, video: streamOfType(1), audio: streamOfType(2), subtitle: streamOfType(3) };
}

function playMethodOf(ts: PlexSessionRaw["TranscodeSession"]): "DirectPlay" | "DirectStream" | "Transcode" {
  if (ts?.videoDecision === "transcode" || ts?.audioDecision === "transcode") return "Transcode";
  if (ts?.videoDecision === "copy" || ts?.audioDecision === "copy") return "DirectStream";
  return "DirectPlay";
}

// Plex's /status/sessions reports WHICH streams it transcoded, never why. A
// video transcode is as often a remote client's quality limit as an
// unsupported codec, so the label says only what Plex said; it used to claim
// "Video codec not supported" for every one, and the Statistics page turned
// that into advice. play-history.ts rewrites those older rows the same way
// (guardrail 19c).
function transcodeReasonOf(ts: PlexSessionRaw["TranscodeSession"], subtitleDecision: string | undefined): string {
  const reasons: string[] = [];
  if (ts?.videoDecision === "transcode") reasons.push(PLEX_VIDEO_TRANSCODED);
  if (ts?.audioDecision === "transcode") reasons.push(PLEX_AUDIO_TRANSCODED);
  if (subtitleDecision === "burn") reasons.push(PLEX_SUBTITLE_BURN_IN);
  if (reasons.length === 0) reasons.push(NO_REASON_REPORTED);
  return reasons.join(", ");
}

function sessionLocation(raw: string | undefined): "lan" | "wan" | "relay" | undefined {
  return raw === "lan" || raw === "wan" || raw === "relay" ? raw : undefined;
}

// One raw session → the shape the poller and the SSE handler consume. A
// session with no key keeps sessionKey "" (the poller skips it); an unknown
// Player.state reads as playing (pinned in tests/plex.test.mts).
function toSessionData(s: PlexSessionRaw): PlexSessionData {
  const { media, video, audio, subtitle } = playingStreams(s);
  const ts = s.TranscodeSession;
  const playMethod = playMethodOf(ts);
  return {
    sessionKey: s.sessionKey ?? s.Session?.id ?? "",
    sessionId: s.Session?.id,
    state: s.Player?.state === "paused" ? "paused" : s.Player?.state === "buffering" ? "buffering" : "playing",
    accountId: s.User?.id ?? "",
    accountName: s.User?.title ?? "",
    accountThumb: s.User?.thumb ?? "",
    ratingKey: s.ratingKey ?? "",
    grandparentRatingKey: s.grandparentRatingKey,
    title: s.type === "episode"
      ? `${s.grandparentTitle ?? ""} — ${s.title ?? ""}`
      : s.title ?? "",
    grandparentTitle: s.grandparentTitle,
    parentIndex: s.parentIndex,
    index: s.index,
    type: s.type ?? "movie",
    year: s.year !== undefined ? String(s.year) : undefined,
    duration: wholeMs(s.duration),
    viewOffset: wholeMs(s.viewOffset),
    Guid: s.Guid,
    platform: s.Player?.platform,
    player: s.Player?.title,
    device: friendlyPlexDevice(s.Player),
    address: s.Player?.address,
    remotePublicAddress: s.Player?.remotePublicAddress,
    playMethod,
    videoCodec: video?.codec,
    audioCodec: audio?.codec,
    resolution: media?.videoResolution,
    bitrate: media?.bitrate,
    videoDecision: ts?.videoDecision ?? video?.decision,
    audioDecision: ts?.audioDecision ?? audio?.decision,
    container: media?.container,
    transcodeReason: playMethod === "Transcode" ? transcodeReasonOf(ts, subtitle?.decision) : undefined,
    location: sessionLocation(s.Session?.location),
    bandwidth: s.Session?.bandwidth,
    secure: toBool(s.Player?.secure),
    relayed: toBool(s.Player?.relayed),
  };
}

export async function getPlexSessions(serverUrl: string, token: string): Promise<PlexSessionData[]> {
  const res = await plexFetch(plexUrl(serverUrl, "/status/sessions?includeGuids=1"), token);
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`Plex sessions: ${res.status}`);
  }
  // No container is a failed read, never "nothing is playing": an empty answer
  // would let the poller's absence sweep finalize live sessions.
  const container = readPlexContainer(await res.json());
  if (!container) throw new Error("Plex sessions: no MediaContainer");
  return parseEach(PlexSessionSchema, container.items).map(toSessionData);
}

// Plex /library/metadata/{ratingKey}?includeMarkers=1 returns intro and credits
// markers as Marker[] entries on the metadata item. Used at session start to
// stamp marker offsets onto ActiveSession so finalize can credit watched at the
// credits boundary without a second metadata fetch at stop time.
export interface PlexMarkers {
  introStartMs?: number;
  introEndMs?: number;
  creditsStartMs?: number;
  creditsEndMs?: number;
}

const PlexMarkerSchema = v.object({
  type: looseString(), // "intro" | "credits"
  startTimeOffset: loose(v.number()),
  endTimeOffset: loose(v.number()),
});
const MarkersItemSchema = v.object({ Marker: looseList(PlexMarkerSchema) });

export async function getPlexMarkers(
  serverUrl: string,
  token: string,
  ratingKey: string,
): Promise<PlexMarkers> {
  try {
    const res = await plexFetch(
      plexUrl(serverUrl, `/library/metadata/${encodeURIComponent(ratingKey)}?includeMarkers=1`),
      token,
    );
    if (!res.ok) return {};
    const first = readPlexContainer(await res.json())?.items[0];
    const item = check(MarkersItemSchema, first);
    return item.ok ? mergeMarkers(item.value.Marker ?? []) : {};
  } catch {
    return {};
  }
}

// Plex emits two credit markers on shows with mid-credit scenes: a non-final
// block for the credits scroll and a `final: true` block for the absolute end.
// Each kind keeps the earliest startTimeOffset (the start of the roll) and the
// latest endTimeOffset, so the answer never depends on the order Plex lists
// them in — intros the same way as credits.
function mergeMarkers(markers: ReadonlyArray<Infer<typeof PlexMarkerSchema>>): PlexMarkers {
  const result: PlexMarkers = {};
  for (const m of markers) {
    if (m.type !== "intro" && m.type !== "credits") continue;
    const [startKey, endKey] = m.type === "intro"
      ? (["introStartMs", "introEndMs"] as const)
      : (["creditsStartMs", "creditsEndMs"] as const);
    if (m.startTimeOffset !== undefined) result[startKey] = Math.min(result[startKey] ?? Infinity, m.startTimeOffset);
    if (m.endTimeOffset !== undefined) result[endKey] = Math.max(result[endKey] ?? -Infinity, m.endTimeOffset);
  }
  return result;
}

// Plex admin endpoint to terminate an in-progress playback. `reason` is shown
// to the user in their player as the stop dialog text. Returns true when Plex
// accepted the request (200 or 204); the actual session teardown is async and
// will surface as a state="stopped" SSE event within a second or two.
export async function terminatePlexSession(
  serverUrl: string,
  token: string,
  sessionId: string,
  reason: string,
): Promise<{ ok: boolean; status: number }> {
  // `sessionId` MUST be the Session.id GUID, not the short sessionKey — Plex
  // matches /status/sessions/terminate against Session.id and 404s on the
  // short key. Same identifier Tautulli's pmsconnect uses (pmsconnect.py:108).
  const url = plexUrl(serverUrl, `/status/sessions/terminate?sessionId=${encodeURIComponent(sessionId)}&reason=${encodeURIComponent(reason)}`);
  const res = await plexFetch(url, token);
  await res.body?.cancel().catch(() => {});
  return { ok: res.ok, status: res.status };
}
