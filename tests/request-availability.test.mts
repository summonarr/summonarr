// Unit tests for src/lib/request-availability.ts — the "requested" badge
// attachment used by every discovery grid. Two contracts matter:
//
// 1. buildMediaTypeWhere partitions items into per-mediaType `tmdbId IN (…)`
//    clauses (it was rewritten from a wide OR precisely so the planner can
//    serve it from the composite (tmdbId, mediaType) index — a regression back
//    to per-item terms would be silent but slow).
// 2. attachRequestedStatus maps DB rows to the `${id}:${MOVIE|TV}` keyspace and
//    scopes to the DEFAULT instance (arrInstance:"") with DECLINED excluded, so
//    a 4K/named-instance request never marks the primary grid CTA as requested.
//
// The DB surface is one mediaRequest.findMany, shadowed in-memory (the
// jellyfin-config.test pattern); the stub dispatches on the presence of
// `requestedBy` to tell the global query from the per-user one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/lib/prisma.ts";
import type { TmdbMedia } from "../src/lib/tmdb-types.ts";
import { buildMediaTypeWhere, attachRequestedStatus } from "../src/lib/request-availability.ts";
import { shadowPrismaModel } from "./_helpers.mts";

function media(id: number, mediaType: "movie" | "tv"): TmdbMedia {
  return { id, mediaType } as unknown as TmdbMedia;
}

// ─── buildMediaTypeWhere (pure) ───────────────────────────────────────────────

test("buildMediaTypeWhere: empty input → null (callers skip the query)", () => {
  assert.equal(buildMediaTypeWhere([]), null);
});

test("buildMediaTypeWhere: movie-only input → a single MOVIE IN-clause", () => {
  assert.deepEqual(buildMediaTypeWhere([media(1, "movie"), media(2, "movie")]), {
    OR: [{ mediaType: "MOVIE", tmdbId: { in: [1, 2] } }],
  });
});

test("buildMediaTypeWhere: tv-only input → a single TV IN-clause", () => {
  assert.deepEqual(buildMediaTypeWhere([media(1399, "tv")]), {
    OR: [{ mediaType: "TV", tmdbId: { in: [1399] } }],
  });
});

test("buildMediaTypeWhere: mixed input partitions ids by type", () => {
  assert.deepEqual(
    buildMediaTypeWhere([media(603, "movie"), media(1399, "tv"), media(604, "movie")]),
    {
      OR: [
        { mediaType: "MOVIE", tmdbId: { in: [603, 604] } },
        { mediaType: "TV", tmdbId: { in: [1399] } },
      ],
    },
  );
});

// ─── attachRequestedStatus (stubbed findMany) ─────────────────────────────────

type Row = { tmdbId: number; mediaType: "MOVIE" | "TV" };
type FindManyArgs = {
  where: { requestedBy?: string; arrInstance?: string; status?: unknown; OR?: unknown };
};

let globalRows: Row[] = [];
let mineRows: Row[] = [];
const calls: FindManyArgs[] = [];

const mediaRequestStub = {
  findMany: async (args: FindManyArgs): Promise<Row[]> => {
    calls.push(args);
    return args.where.requestedBy ? mineRows : globalRows;
  },
};

shadowPrismaModel(prisma, "mediaRequest", mediaRequestStub);

test("attachRequestedStatus: empty input returns as-is with zero queries", async () => {
  calls.length = 0;
  assert.deepEqual(await attachRequestedStatus([]), []);
  assert.equal(calls.length, 0);
});

test("attachRequestedStatus: maps rows through the '{id}:{MOVIE|TV}' keyspace", async () => {
  calls.length = 0;
  globalRows = [{ tmdbId: 603, mediaType: "MOVIE" }];
  mineRows = [{ tmdbId: 1399, mediaType: "TV" }];
  const out = await attachRequestedStatus(
    [media(603, "movie"), media(1399, "tv"), media(999, "movie")],
    "u_1",
  );
  assert.deepEqual(
    out.map((i) => ({ id: i.id, requested: i.requested, requestedByMe: i.requestedByMe })),
    [
      { id: 603, requested: true, requestedByMe: false },
      { id: 1399, requested: false, requestedByMe: true },
      { id: 999, requested: false, requestedByMe: false },
    ],
  );
  // A MOVIE row must never mark the same tmdbId's TV entry (and vice versa).
  const crossType = await attachRequestedStatus([media(603, "tv")], "u_1");
  assert.equal(crossType[0].requested, false);
});

test("attachRequestedStatus: both queries scope to the default instance and exclude DECLINED", async () => {
  calls.length = 0;
  globalRows = [];
  mineRows = [];
  await attachRequestedStatus([media(1, "movie")], "u_1");
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.where.arrInstance, "");
    assert.deepEqual(call.where.status, { not: "DECLINED" });
    assert.deepEqual(call.where.OR, [{ mediaType: "MOVIE", tmdbId: { in: [1] } }]);
  }
  const mine = calls.filter((c) => c.where.requestedBy);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].where.requestedBy, "u_1");
});

test("attachRequestedStatus: without a userId the per-user query is skipped", async () => {
  calls.length = 0;
  globalRows = [{ tmdbId: 1, mediaType: "MOVIE" }];
  const out = await attachRequestedStatus([media(1, "movie")]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].where.requestedBy, undefined);
  assert.equal(out[0].requested, true);
  assert.equal(out[0].requestedByMe, false);
});
