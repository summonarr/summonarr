// Bitrate unit reconciliation — the single source of truth for reading a stored
// `bitrate` column (PlayHistory / ActiveSession) as kbps.
//
// The two media servers disagree on units, and the column stores whatever the
// upstream reported, VERBATIM — there is no write-time normalization (see
// recordCompletedSession in play-history.ts and the ActiveSession writes in
// /api/sync/play-history). So the unit is a property of the row's `source`:
//
//   plex     → kbps  (/status/sessions Media.bitrate — a 20 Mbps file reads 20000)
//   jellyfin → bps   (TranscodingInfo.Bitrate / MediaStream.BitRate — the same
//                     file reads 20000000; cf. Jellyfin's own
//                     RemoteClientBitrateLimit: 20000000 for a 20 Mbps cap)
//
// NEVER reconcile these by magnitude. A `bitrate > N` threshold must separate
// two ranges that genuinely OVERLAP, so every N is wrong somewhere, and both
// wrong answers have shipped:
//
//   N = 100_000    breaks Plex UHD. 128000 kbps (a 128 Mbps Blu-ray remux) is
//                  above it, so a real 4K session was divided by 1000 and read
//                  as 0.128 Mbps — erasing the heaviest sessions from the very
//                  stat meant to surface them.
//   N = 1_000_000  breaks Jellyfin low-bitrate. Anything under 1 Mbps — music,
//                  and Jellyfin's stock sub-1-Mbps mobile transcode rungs —
//                  stays unscaled and is read as kbps, INFLATING it 1000x. A
//                  2-hour 720 kbps phone stream reported 648 GB of bandwidth
//                  against a true 0.65 GB.
//
// The second failure is the more dangerous one, and it is why "rare, and it
// contributes little bandwidth" is NOT a valid reason to accept a gap here: the
// error multiplies the row's contribution by 1000, so the LIGHTEST sessions
// become the heaviest line items on the panel. A single phone stream can
// outweigh a real month.
//
// `source` is authoritative, present on every row, and cannot overlap. Key on
// it. If a third media server is ever added, add it here — not at a call site.
//
// PURE — zero imports, so client components (the activity/now-playing UI) and
// server SQL builders share one definition. They previously each carried their
// own copy and drifted: the fix that raised the SQL threshold left the two
// client helpers on the old one.

// Sources whose `bitrate` column is bits-per-second rather than kbps.
const BPS_SOURCES = new Set(["jellyfin"]);

// SQL fragment yielding the row's bitrate in kbps as float8, or NULL when the
// column is NULL. Unaliased — every call site selects `FROM "PlayHistory"`
// without an alias. Callers that want Mbps divide this by 1000.
export const BITRATE_KBPS_SQL =
  `(CASE WHEN "source" = 'jellyfin' THEN "bitrate" / 1000.0 ELSE "bitrate"::float8 END)`;

// Estimated bytes-on-the-wire bitrate in kbps — what the stats layer multiplies
// by playDuration for every Bandwidth figure. NULL exactly when `bitrate` is.
//
// Three of the four (server × play-method) cases already ARE delivered bytes:
//
//   plex     DirectPlay   source bitrate — the file is pushed as-is         ✓
//   jellyfin DirectPlay   source total (jellyfin.ts sourceBitrateBps)       ✓
//   jellyfin Transcode    TranscodingInfo.Bitrate is the OUTPUT rate        ✓
//   plex     Transcode    source bitrate — OVER-reports, often ~10x
//
// The fourth cannot be read directly: Plex exposes no transcode output bitrate
// anywhere in /status/sessions. TranscodeSession carries width, height, codec,
// container, size, speed and progress — and no bitrate field at all.
//
// Session.bandwidth is the Streaming Brain's RESERVED figure for the session:
// an estimate of what it intends to push, explicitly "not the used bandwidth"
// in Tautulli's own field docs, and known to occasionally report absurd values
// (10500 Mbps has been seen in the wild). So it is used ONLY where it can
// strictly improve the answer, and it is clamped:
//
//   when transcoding, delivered can never exceed the source, so LEAST() caps a
//   garbage reading at the source bitrate — which is exactly the number this
//   expression would have produced without the clamp.
//
// That bound is the whole point: this can never be worse than measuring at
// source, only closer. A NULL/zero bandwidth (rows predating the column;
// Jellyfin never populates it) falls through unchanged.
//
// NOT applied to DirectPlay: there the source bitrate IS the delivered bitrate,
// exactly, and a reserved-bandwidth estimate could only add error.
export const DELIVERED_KBPS_SQL =
  `(CASE WHEN "source" = 'plex' AND "playMethod" = 'Transcode' ` +
  `AND "bandwidth" > 0 AND "bitrate" > 0 ` +
  `THEN LEAST("bandwidth"::float8, ${BITRATE_KBPS_SQL}) ` +
  `ELSE ${BITRATE_KBPS_SQL} END)`;

// TS counterpart of BITRATE_KBPS_SQL. Returns 0 for absent/non-positive input
// so callers can format it as "no data" without a second null check.
//
// Deliberately the UNIT normalization only, not DELIVERED_KBPS_SQL's estimate:
// its callers render a single row's "Bitrate" field in the history detail view,
// which sits directly beside a separate "Session bandwidth" line. Folding the
// clamp in would make those two lines silently describe the same quantity.
export function bitrateToKbps(
  raw: number | null | undefined,
  source: string | null | undefined,
): number {
  if (!raw || raw <= 0) return 0;
  return BPS_SOURCES.has(source ?? "") ? raw / 1000 : raw;
}
