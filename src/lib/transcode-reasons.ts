// Transcode-reason vocabulary shared by the capture side (plex.ts / jellyfin.ts),
// the aggregate SQL (play-history.ts) and the admin activity UI. Pure and
// zero-import, so "use client" components import it directly.
//
// A stored PlayHistory.transcodeReason is English: Jellyfin's TranscodeReasons
// enum humanized ("VideoCodecNotSupported" → "Video codec not supported"), or the
// Plex labels below, comma-joined when there are several. The UI translates each
// part through TRANSCODE_REASON_KEYS; a phrase it doesn't know is shown as stored.

// Plex's /status/sessions reports WHICH streams it transcoded (videoDecision /
// audioDecision / a burned subtitle), never WHY — a remote client's quality limit
// transcodes a video Plex could have played directly. These labels say only what
// Plex said.
export const PLEX_VIDEO_TRANSCODED = "Video transcoded";
export const PLEX_AUDIO_TRANSCODED = "Audio transcoded";
export const PLEX_SUBTITLE_BURN_IN = "Subtitle burn-in";
// A transcode the server reported no reason for.
export const NO_REASON_REPORTED = "No reason reported";

// The aggregate SQL's own buckets: rows with no reason at all (sessions recorded
// before reasons were captured), and the rolled-up tail past the top buckets.
export const UNKNOWN_REASON = "Unknown";
export const OTHER_REASONS = "Other reasons";

// Plex rows recorded before plex.ts stopped guessing carry a CAUSE Plex never
// reported: every video transcode was "Video codec not supported", every audio
// one "Audio codec not supported" (and "Container not supported" was the
// unreachable fallback). Read back, they mean only what Plex did report.
// play-history.ts rewrites them on Plex rows ONLY — on a Jellyfin row the same
// words are Jellyfin's own reason and stay as they are.
export const LEGACY_PLEX_REASON_LABELS: Record<string, string> = {
  "Video codec not supported": PLEX_VIDEO_TRANSCODED,
  "Audio codec not supported": PLEX_AUDIO_TRANSCODED,
  "Container not supported": NO_REASON_REPORTED,
};

// English phrase → catalog key. A literal map, never keys built from the phrase,
// so the i18n dead-string check can see every key. Covers Jellyfin's
// TranscodeReason enum (10.8–10.10) as humanizeJellyfinReasons renders it.
export const TRANSCODE_REASON_KEYS: Record<string, string> = {
  [PLEX_VIDEO_TRANSCODED]: "adminActivity.reason.videoTranscoded",
  [PLEX_AUDIO_TRANSCODED]: "adminActivity.reason.audioTranscoded",
  [PLEX_SUBTITLE_BURN_IN]: "adminActivity.reason.subtitleBurnIn",
  [NO_REASON_REPORTED]: "adminActivity.reason.noReasonReported",
  [UNKNOWN_REASON]: "adminActivity.stats.unknown",
  [OTHER_REASONS]: "adminActivity.reason.otherReasons",
  "Container not supported": "adminActivity.reason.containerNotSupported",
  "Video codec not supported": "adminActivity.reason.videoCodecNotSupported",
  "Audio codec not supported": "adminActivity.reason.audioCodecNotSupported",
  "Subtitle codec not supported": "adminActivity.reason.subtitleCodecNotSupported",
  "Audio is external": "adminActivity.reason.audioIsExternal",
  "Secondary audio not supported": "adminActivity.reason.secondaryAudioNotSupported",
  "Video profile not supported": "adminActivity.reason.videoProfileNotSupported",
  "Video level not supported": "adminActivity.reason.videoLevelNotSupported",
  "Video resolution not supported": "adminActivity.reason.videoResolutionNotSupported",
  "Video bit depth not supported": "adminActivity.reason.videoBitDepthNotSupported",
  "Video framerate not supported": "adminActivity.reason.videoFramerateNotSupported",
  "Ref frames not supported": "adminActivity.reason.refFramesNotSupported",
  "Anamorphic video not supported": "adminActivity.reason.anamorphicVideoNotSupported",
  "Interlaced video not supported": "adminActivity.reason.interlacedVideoNotSupported",
  "Audio channels not supported": "adminActivity.reason.audioChannelsNotSupported",
  "Audio profile not supported": "adminActivity.reason.audioProfileNotSupported",
  "Audio sample rate not supported": "adminActivity.reason.audioSampleRateNotSupported",
  "Audio bit depth not supported": "adminActivity.reason.audioBitDepthNotSupported",
  "Container bitrate exceeds limit": "adminActivity.reason.containerBitrateExceedsLimit",
  "Video bitrate not supported": "adminActivity.reason.videoBitrateNotSupported",
  "Audio bitrate not supported": "adminActivity.reason.audioBitrateNotSupported",
  "Unknown video stream info": "adminActivity.reason.unknownVideoStreamInfo",
  "Unknown audio stream info": "adminActivity.reason.unknownAudioStreamInfo",
  "Direct play error": "adminActivity.reason.directPlayError",
  "Video range type not supported": "adminActivity.reason.videoRangeTypeNotSupported",
  "Video codec tag not supported": "adminActivity.reason.videoCodecTagNotSupported",
  "Stream count exceeds limit": "adminActivity.reason.streamCountExceedsLimit",
};

const REASON_SEPARATOR = ", ";

/** Translate a stored (possibly comma-joined) reason, part by part. */
export function translateTranscodeReason(reason: string, t: (key: string) => string): string {
  return reason
    .split(REASON_SEPARATOR)
    .map((part) => {
      const key = TRANSCODE_REASON_KEYS[part];
      return key ? t(key) : part;
    })
    .join(REASON_SEPARATOR);
}

const PLEX_WHAT_LABELS = new Set([PLEX_VIDEO_TRANSCODED, PLEX_AUDIO_TRANSCODED]);

/** True when a reason names only which Plex stream was transcoded, not a cause. */
export function isPlexStreamOnlyReason(reason: string): boolean {
  return reason.split(REASON_SEPARATOR).some((part) => PLEX_WHAT_LABELS.has(part));
}
