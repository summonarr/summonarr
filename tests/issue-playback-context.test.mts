// Pure rules for the playback context an issue carries
// (src/lib/issue-playback-context.ts).
import { test } from "node:test";
import assert from "node:assert/strict";

const m = await import("../src/lib/issue-playback-context.ts");
const { pickPlay, buildPlaybackContext, parsePlaybackContext, formatBitrate, PLAYBACK_CONTEXT_WINDOW_DAYS } = m;

const NOW = new Date("2026-10-31T12:00:00Z");
const at = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * 86_400_000);

function row(over: Record<string, unknown> = {}) {
  return {
    source: "plex", startedAt: at(1), stoppedAt: at(1), seasonNumber: null, episodeNumber: null,
    platform: "Roku", player: "Living room", device: "Roku Ultra", playMethod: "Transcode",
    videoDecision: "transcode", audioDecision: "copy", videoCodec: "hevc", audioCodec: "eac3",
    resolution: "1080", container: "mkv", bitrate: 8200, transcodeReason: "Video transcoded",
    location: "wan", relayed: false, ...over,
  };
}
const FULL = { scope: "FULL" as const, seasonNumber: null, episodeNumber: null };

test("picks the newest play inside the window; nothing when all are older", () => {
  const picked = pickPlay([row({ stoppedAt: at(5), player: "old" }), row({ stoppedAt: at(1), player: "new" })], FULL, NOW);
  assert.equal(picked?.row.player, "new");
  assert.equal(pickPlay([row({ stoppedAt: at(PLAYBACK_CONTEXT_WINDOW_DAYS + 1) })], FULL, NOW), null);
  assert.equal(pickPlay([], FULL, NOW), null);
});

test("an episode issue prefers the exact episode over a newer one, then the season, then any play (exact:false)", () => {
  const scope = { scope: "EPISODE" as const, seasonNumber: 2, episodeNumber: 3 };
  const rows = [
    row({ seasonNumber: 2, episodeNumber: 3, stoppedAt: at(9), player: "exact" }),
    row({ seasonNumber: 2, episodeNumber: 4, stoppedAt: at(1), player: "same-season" }),
    row({ seasonNumber: 1, episodeNumber: 1, stoppedAt: at(0.5), player: "other" }),
  ];
  assert.deepEqual([pickPlay(rows, scope, NOW)?.row.player, pickPlay(rows, scope, NOW)?.exact], ["exact", true]);
  const noExact = pickPlay(rows.slice(1), scope, NOW);
  assert.deepEqual([noExact?.row.player, noExact?.exact], ["same-season", false]);
  const onlyOther = pickPlay(rows.slice(2), scope, NOW);
  assert.deepEqual([onlyOther?.row.player, onlyOther?.exact], ["other", false]);
});

test("a season issue matches on season only", () => {
  const scope = { scope: "SEASON" as const, seasonNumber: 3, episodeNumber: null };
  const p = pickPlay([row({ seasonNumber: 1, stoppedAt: at(0.5) }), row({ seasonNumber: 3, stoppedAt: at(4), player: "s3" })], scope, NOW);
  assert.deepEqual([p?.row.player, p?.exact], ["s3", true]);
});

test("the snapshot carries NO network identifier, and bitrate is source-normalized (guardrail 19a)", () => {
  const withIp = { ...row(), ipAddress: "203.0.113.9" } as unknown as ReturnType<typeof row>;
  const plex = buildPlaybackContext(withIp, true);
  assert.equal(JSON.stringify(plex).includes("203.0.113.9"), false);
  assert.ok(!("ipAddress" in plex));
  assert.equal(plex.bitrateKbps, 8200, "plex bitrate is already kbps");
  const jf = buildPlaybackContext(row({ source: "jellyfin", bitrate: 8_200_000 }), true);
  assert.equal(jf.bitrateKbps, 8200, "jellyfin reports bps");
  assert.equal(buildPlaybackContext(row({ bitrate: null }), true).bitrateKbps, null);
});

test("parsePlaybackContext round-trips a built context and rejects anything else without throwing", () => {
  const built = buildPlaybackContext(row(), true);
  assert.deepEqual(parsePlaybackContext(JSON.parse(JSON.stringify(built))), built);
  for (const bad of [null, undefined, 5, "x", [], {}, { v: 2 }, { v: 1 }, { v: 1, playedAt: "nope", source: "plex" }]) {
    assert.equal(parsePlaybackContext(bad), null, JSON.stringify(bad));
  }
  const hostile = parsePlaybackContext({ v: 1, playedAt: built.playedAt, source: "plex", player: "x".repeat(500), bitrateKbps: -4 });
  assert.equal(hostile?.player?.length, 64);
  assert.equal(hostile?.bitrateKbps, null);
});

test("formatBitrate", () => {
  assert.equal(formatBitrate(8200), "8.2 Mbps");
  assert.equal(formatBitrate(640), "640 kbps");
});
