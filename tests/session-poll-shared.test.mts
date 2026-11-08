// The helpers both poller passes share (src/lib/session-poll-shared.ts).
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.TOKEN_ENCRYPTION_KEY ??= "ab".repeat(32);
process.env.DATABASE_URL ??= "postgresql://unit:unit@127.0.0.1:9/never_connects";

const { progressPercentOf, posterOf, continuingUpdateFields } = await import("../src/lib/session-poll-shared.ts");

test("progressPercentOf is 0 for an unknown duration and a plain ratio otherwise", () => {
  assert.equal(progressPercentOf(500, 0), 0);
  assert.equal(progressPercentOf(250, 1000), 25);
});

test("posterOf answers only for a resolved title the tick looked up", () => {
  const posters = new Map<string, string | null>([["7:MOVIE", "/p.jpg"], ["8:TV", null]]);
  assert.equal(posterOf(posters, 7, "MOVIE"), "/p.jpg");
  assert.equal(posterOf(posters, 8, "TV"), null);
  assert.equal(posterOf(posters, 7, "TV"), null);
  assert.equal(posterOf(posters, null, "MOVIE"), null);
  assert.equal(posterOf(posters, 7, null), null);
});

test("continuingUpdateFields writes each field only when it has something to say", () => {
  const none = continuingUpdateFields({ existing: { durationMs: 5n }, increment: 0n, durationMs: 100, tmdbId: null, mediaType: null, posterPath: null });
  assert.deepEqual(none, {});
  const all = continuingUpdateFields({ existing: { durationMs: 0n }, increment: 5000n, durationMs: 100, tmdbId: 7, mediaType: "MOVIE", posterPath: "/p.jpg" });
  assert.deepEqual(all, { playtimeMs: { increment: 5000n }, durationMs: 100n, tmdbId: 7, mediaType: "MOVIE", posterPath: "/p.jpg" });
  const noDuration = continuingUpdateFields({ existing: { durationMs: 0n }, increment: 0n, durationMs: 0, tmdbId: null, mediaType: null, posterPath: null });
  assert.deepEqual(noDuration, {}, "a zero duration is never backfilled");
});
