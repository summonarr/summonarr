// The Now playing grid's rules (src/components/admin/now-playing/rules.ts): the
// terminate target, the credits chip, the network cell, how a live push merges
// into the grid, the subtitle, and what a terminate answer does to the dialog.
// Plus the shared accent hash (activity-accent.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  creditsRange,
  mergeLiveSessions,
  networkSignals,
  nowPlayingSubtitle,
  terminateOutcome,
  terminateTargetFor,
} from "../src/components/admin/now-playing/rules.ts";
import { accentFor } from "../src/components/admin/activity-accent.ts";

const t = (key: string, vars?: Record<string, string | number>) =>
  vars ? `<${key} ${JSON.stringify(vars)}>` : `<${key}>`;

test("the terminate target parses the instance out of the session id, per source", () => {
  assert.deepEqual(terminateTargetFor("plex:abc"), {
    endpoint: "/api/admin/play-history/terminate-session",
    sessionKey: "abc",
    serverInstance: "",
  });
  assert.deepEqual(terminateTargetFor("jellyfin:remote:xyz"), {
    endpoint: "/api/admin/play-history/terminate-jellyfin-session",
    sessionKey: "xyz",
    serverInstance: "remote",
  });
  assert.equal(terminateTargetFor("emby:abc"), null, "a source that can't be stopped from here has no button");
});

test("credits run to the end only when the title's length is known", () => {
  assert.deepEqual(creditsRange(100, 7999_500, 8000_000), { start: 100, end: null }, "within the last second: start+");
  assert.deepEqual(creditsRange(100, 500, 8000_000), { start: 100, end: 500 });
  assert.deepEqual(creditsRange(100, 500, 0), { start: 100, end: 500 }, "an unknown length never swallows a known end");
  assert.deepEqual(creditsRange(100, null, 8000_000), { start: 100, end: 8000_000 });
  assert.deepEqual(creditsRange(100, null, 0), { start: 100, end: null }, "no end and no length: open, never 0:00");
});

test("the network cell shows a placeholder when it has nothing, relayed=false included", () => {
  assert.equal(networkSignals({ location: null, secure: null, relayed: false }).empty, true);
  assert.equal(networkSignals({ location: null, secure: null, relayed: null }).empty, true);
  assert.deepEqual(networkSignals({ location: "relay", secure: null, relayed: true }), {
    location: "relay",
    relay: false,
    secure: null,
    empty: false,
  }, "a relayed session whose location already reads relay shows it once");
  assert.equal(networkSignals({ location: "wan", secure: null, relayed: true }).relay, true);
  assert.equal(networkSignals({ location: null, secure: false, relayed: null }).empty, false);
});

const session = (over: Partial<{ id: string; source: string; tmdbId: number | null; mediaType: string | null; posterUrl: string | null }>) => ({
  id: "plex:1",
  source: "plex",
  tmdbId: null,
  mediaType: null,
  posterUrl: null,
  ...over,
});

test("a live push keeps the identity the page resolved by title, which the push can't carry", () => {
  const prev = [session({ id: "plex:1", tmdbId: 603, mediaType: "MOVIE", posterUrl: "/p.jpg" })];
  const [merged] = mergeLiveSessions(prev, [session({ id: "plex:1", tmdbId: null, mediaType: null })], {});
  assert.equal(merged.tmdbId, 603);
  assert.equal(merged.mediaType, "MOVIE");
  assert.equal(merged.posterUrl, "/p.jpg");
  const [ownType] = mergeLiveSessions(
    [session({ tmdbId: 66732, mediaType: "TV" })],
    [session({ tmdbId: null, mediaType: "MOVIE" })],
    {},
  );
  assert.equal(ownType.mediaType, "MOVIE", "the session's own known type wins");
});

test("a push that carries its own tmdbId wins, and another session never lends its identity", () => {
  const prev = [session({ id: "plex:1", tmdbId: 603, mediaType: "MOVIE" })];
  assert.equal(mergeLiveSessions(prev, [session({ id: "plex:1", tmdbId: 604, mediaType: "MOVIE" })], {})[0].tmdbId, 604);
  assert.equal(mergeLiveSessions(prev, [session({ id: "plex:2" })], {})[0].tmdbId, null);
});

test("a push is filtered to the page's Source and Type", () => {
  const incoming = [
    session({ id: "plex:1", mediaType: "MOVIE" }),
    session({ id: "jellyfin:2", source: "jellyfin", mediaType: "TV" }),
    session({ id: "plex:3", mediaType: "tv" }),
  ];
  assert.deepEqual(mergeLiveSessions([], incoming, { source: "plex" }).map((s) => s.id), ["plex:1", "plex:3"]);
  assert.deepEqual(mergeLiveSessions([], incoming, { mediaType: "TV" }).map((s) => s.id), ["jellyfin:2", "plex:3"]);
});

test("the subtitle is translated, with the Plex/Jellyfin split only when both have streams", () => {
  assert.equal(nowPlayingSubtitle([], t, "en"), "<adminActivity.nowPlaying.noActiveLower>");
  assert.equal(
    nowPlayingSubtitle([{ source: "plex", bitrate: null }], t, "en"),
    '<adminActivity.nowPlaying.activeCount {"count":1}>',
  );
  assert.equal(
    nowPlayingSubtitle([{ source: "plex", bitrate: 8000 }, { source: "jellyfin", bitrate: 4_000_000 }], t, "en"),
    '<adminActivity.nowPlaying.activeCount {"count":2}> · <adminActivity.nowPlaying.sourceSplit {"plex":1,"jellyfin":1}>' +
      ' · <adminActivity.nowPlaying.combined {"mbps":"12"}>',
  );
});

test("a terminate answer: success closes and marks the card, a refusal shows the route's reason, no answer shows translated copy", () => {
  const fail = (kind: "http" | "network" | "timeout" | "invalid" | "aborted", body: unknown, error = "<fallback>") =>
    ({ ok: false, kind, status: kind === "http" ? 502 : 0, error, body, detail: "Failed to fetch" }) as const;
  assert.deepEqual(terminateOutcome({ ok: true, status: 200, data: { ok: true } }, t), { kind: "requested" });
  assert.deepEqual(terminateOutcome(fail("aborted", null, ""), t), { kind: "ignore" });
  assert.deepEqual(terminateOutcome(fail("http", { error: "Plex refused" }, "Plex refused"), t), { kind: "error", message: "Plex refused" });
  assert.deepEqual(terminateOutcome(fail("http", null), t), { kind: "error", message: "<adminActivity.terminate.unknownError>" });
  const offline = terminateOutcome(fail("network", null), t);
  assert.equal(offline.kind, "error");
  assert.equal(offline.kind === "error" ? offline.message : "", "<adminActivity.terminate.networkError>");
  assert.doesNotMatch(offline.kind === "error" ? offline.message : "", /Failed to fetch/, "the browser's own English stays in the log");
  assert.equal(terminateOutcome(fail("timeout", null), t).kind, "error");
});

test("the accent is a stable hash of its seed, spread over the wheel", () => {
  assert.equal(accentFor("The Matrix"), accentFor("The Matrix"));
  const hue = (s: string) => Number(/oklch\(0\.38 0\.08 (\d+)\)/.exec(accentFor(s))?.[1]);
  for (let i = 0; i < 200; i++) {
    const h = hue(`seed-${i}`);
    assert.ok(Number.isInteger(h) && h >= 0 && h < 360, `hue ${h} in range`);
  }
  // Seeds a character apart land far apart, not a degree or two.
  const gap = Math.abs(hue("u1") - hue("u2"));
  assert.ok(Math.min(gap, 360 - gap) > 5, `u1/u2 hues ${hue("u1")}/${hue("u2")}`);
});

test("the media type filter matches whatever the case of the filter", () => {
  const incoming = [session({ id: "plex:2", mediaType: "movie" })];
  assert.equal(mergeLiveSessions([], incoming, { mediaType: "movie" }).length, 1);
  assert.equal(mergeLiveSessions([], incoming, { mediaType: "MOVIE" }).length, 1);
  assert.equal(mergeLiveSessions([], incoming, { mediaType: "TV" }).length, 0);
});
