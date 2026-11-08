// The admin play-history table's query builders and row shaping
// (src/lib/play-history-list.ts): the ORDER BY column only ever comes from the
// sort whitelist, and both modes answer the same `mediaServerUser` shape.
import { test } from "node:test";
import assert from "node:assert/strict";

const { parsePlayHistorySort, ungroupedListSql, groupedListSql, shapeUngroupedRow, shapeGroupedRow } = await import("../src/lib/play-history-list.ts");

test("?sortBy= is a whitelist: anything else sorts by startedAt, and only a whitelisted name reaches the ORDER BY", () => {
  for (const ok of ["startedAt", "title", "playDuration", "duration", "source", "platform"]) {
    assert.equal(parsePlayHistorySort(ok), ok);
  }
  for (const bad of [null, "", "id\" DESC; DROP TABLE x; --", "ipAddress", "__proto__", "constructor"]) {
    assert.equal(parsePlayHistorySort(bad), "startedAt", String(bad));
  }
  const { dataSql } = ungroupedListSql("", 1, parsePlayHistorySort('title" DESC; --'), "asc");
  assert.match(dataSql, /ORDER BY h\."startedAt" ASC, h\."id" ASC/);
});

test("grouped: playDuration sorts by the chain's total; the bind slots follow the filters", () => {
  const { dataSql } = groupedListSql(' AND h."source" = $1', 2, "playDuration", "desc", null);
  assert.match(dataSql, /ORDER BY b\."total_play_duration" DESC NULLS LAST, b\.chain_id DESC/);
  assert.match(dataSql, /LIMIT \$2 OFFSET \$3/);
  const watched = groupedListSql("", 1, "title", "asc", "false");
  assert.match(watched.dataSql, /WHERE b\.rn = 1 AND b\.chain_watched = FALSE/);
  assert.match(watched.countSql, /chain_watched = FALSE/);
});

const baseRow = {
  id: "ph-1", referenceId: null, tmdbId: 603, mediaType: "MOVIE", posterPath: "/snap.jpg",
  playDuration: 100, pausedDuration: 5, startedAt: new Date("2026-01-01T00:00:00Z"), stoppedAt: new Date("2026-01-01T01:00:00Z"),
  watched: false, completed: false,
};

test("both modes answer mediaServerUser as null when the join found no server user, and the same object otherwise", () => {
  const joined = { msu_username: "alice", msu_source: "plex", msu_thumb_url: null };
  const missing = { msu_username: null, msu_source: null, msu_thumb_url: null };
  const ungrouped = (msu: typeof joined | typeof missing, user: { msu_user_id: string | null; msu_user_name: string | null }) =>
    shapeUngroupedRow({ ...baseRow, ...msu, ...user } as never, {});
  assert.deepEqual(ungrouped(joined, { msu_user_id: "u1", msu_user_name: null }).mediaServerUser, { username: "alice", source: "plex", thumbUrl: null, user: { name: null } });
  assert.deepEqual(ungrouped(joined, { msu_user_id: null, msu_user_name: null }).mediaServerUser, { username: "alice", source: "plex", thumbUrl: null, user: null });
  assert.equal(ungrouped(missing, { msu_user_id: null, msu_user_name: null }).mediaServerUser, null);

  const groupedExtras = {
    chain_id: "ph-1", rn: 1, segment_count: 2, total_play_duration: 200, total_paused_duration: 7,
    first_started_at: baseRow.startedAt, last_stopped_at: baseRow.stoppedAt, chain_watched: true, chain_completed: false,
  };
  assert.deepEqual(shapeGroupedRow({ ...baseRow, ...joined, ...groupedExtras } as never, {}).mediaServerUser, { username: "alice", source: "plex", thumbUrl: null });
  assert.equal(shapeGroupedRow({ ...baseRow, ...missing, ...groupedExtras } as never, {}).mediaServerUser, null);
});

test("grouped rows carry each alias once, camelCased, with the chain's watched in place of the segment's", () => {
  const row = shapeGroupedRow({
    ...baseRow, msu_username: "alice", msu_source: "plex", msu_thumb_url: null,
    chain_id: "ph-0", rn: 1, segment_count: 3, total_play_duration: 300, total_paused_duration: 9,
    first_started_at: baseRow.startedAt, last_stopped_at: baseRow.stoppedAt, chain_watched: true, chain_completed: true,
  } as never, { "movie:603": "/live.jpg" });
  for (const alias of ["chain_id", "rn", "segment_count", "msu_username"]) assert.ok(!(alias in row), alias);
  assert.equal(row.segmentCount, 3);
  assert.equal(row.chainId, "ph-0");
  assert.equal(row.watched, true);
  assert.equal(row.posterPath, "/live.jpg", "the live path wins over the snapshot");
});
