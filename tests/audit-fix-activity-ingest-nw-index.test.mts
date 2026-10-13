// Audit C005 — the never-watched NARROWED read (the ADMIN detail-page chip, the
// cleanup delete's re-judgement) must stay index-served:
//   - a show's plays are looked up by `sourceShowId IN (…)` → PlayHistory needs
//     @@index([sourceShowId]) (there was none: a sequential scan per TV view);
//   - a movie's plays are looked up by `sourceItemId IN (…)`, and PlayHistory's
//     only sourceItemId index is led by `source` → the narrowed read names the
//     keys' own sources. That is lossless (a key group counts only when its
//     (source, instance, key) is a holder's), which the parity check below
//     re-proves for a title whose only hard evidence is a Jellyfin key.
// The full read carries no source predicate (guardrail 14d, the structural
// test 7 in never-watched-data.test.mts). No DB, no network.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { shadowPrismaClientMethod, shadowPrismaModel } from "./_helpers.mts";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
console.warn = () => {};

// ── schema ──────────────────────────────────────────────────────────────────

test("C005 PlayHistory declares @@index([sourceShowId]) — the narrowed show read's only index", () => {
  const schema = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");
  const model = /^model PlayHistory \{([\s\S]*?)^\}/m.exec(schema);
  assert.ok(model, "PlayHistory model did not parse");
  const indexes = [...model[1].matchAll(/^\s*@@index\(\[([^\]]*)\]/gm)].map((m) =>
    m[1].split(",").map((c) => c.trim().replace(/\(.*\)$/, "")).join(","),
  );
  assert.ok(indexes.length > 5, `PlayHistory's @@index lines did not parse: ${JSON.stringify(indexes)}`);
  assert.ok(
    indexes.some((ix) => ix.split(",")[0] === "sourceShowId"),
    `no PlayHistory index leads with sourceShowId: ${JSON.stringify(indexes)}`,
  );
  assert.ok(
    indexes.some((ix) => ix.startsWith("source,sourceItemId")),
    "the movie read's [source, sourceItemId, …] index is what the source scope relies on",
  );
});

// ── loader harness (the never-watched-data.test.mts evaluator, trimmed) ─────

const { prisma } = await import("../src/lib/prisma.ts");

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

function matchField(v: unknown, cond: unknown): boolean {
  if (cond === null || typeof cond !== "object" || cond instanceof Date) return v === cond;
  const c = cond as Record<string, unknown>;
  if ("in" in c) return (c.in as unknown[]).includes(v);
  if ("hasSome" in c) return Array.isArray(v) && (c.hasSome as unknown[]).some((x) => (v as unknown[]).includes(x));
  if ("not" in c && c.not === null) return v !== null && v !== undefined;
  if ("equals" in c) {
    return c.mode === "insensitive"
      ? String(v ?? "").toLowerCase() === String(c.equals).toLowerCase()
      : v === c.equals;
  }
  if ("startsWith" in c) return String(v).startsWith(String(c.startsWith));
  if ("contains" in c) {
    return c.mode === "insensitive"
      ? String(v ?? "").toLowerCase().includes(String(c.contains).toLowerCase())
      : String(v ?? "").includes(String(c.contains));
  }
  throw new Error(`unsupported condition ${JSON.stringify(cond)}`);
}

function matchWhere(row: Row, where: Where | undefined): boolean {
  if (!where) return true;
  for (const [k, cond] of Object.entries(where)) {
    if (k === "OR") {
      if (!(cond as Where[]).some((w) => matchWhere(row, w))) return false;
      continue;
    }
    if (!matchField(row[k], cond)) return false;
  }
  return true;
}

function groupBy(rows: Row[], args: { by: string[]; where?: Where; _count?: unknown; _max?: Record<string, true>; _min?: Record<string, true> }) {
  const groups = new Map<string, Row[]>();
  for (const r of rows.filter((x) => matchWhere(x, args.where))) {
    const key = JSON.stringify(args.by.map((f) => r[f] ?? null));
    const list = groups.get(key);
    if (list) list.push(r);
    else groups.set(key, [r]);
  }
  return [...groups.values()].map((list) => {
    const out: Row = {};
    for (const f of args.by) out[f] = list[0][f] ?? null;
    if (args._count) out._count = { _all: list.length };
    const agg = (field: string, pick: (a: Date, b: Date) => Date) =>
      list.map((r) => r[field] as Date | null).filter((x): x is Date => x instanceof Date).reduce<Date | null>((a, x) => (a ? pick(a, x) : x), null);
    if (args._max) out._max = Object.fromEntries(Object.keys(args._max).map((f) => [f, agg(f, (a, b) => (b > a ? b : a))]));
    if (args._min) out._min = Object.fromEntries(Object.keys(args._min).map((f) => [f, agg(f, (a, b) => (b < a ? b : a))]));
    return out;
  });
}

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const NOW = d("2026-10-01");

let plexLib: Row[] = [];
let jfLib: Row[] = [];
let plays: Row[] = [];
const groupByCalls: Array<{ by: string[]; where?: Where }> = [];

const settings = new Map<string, string>([
  ["playHistoryEnabled", "true"],
  ["playHistoryPlexEnabled", "true"],
  ["playHistoryJellyfinEnabled", "true"],
]);

shadowPrismaModel(prisma, "plexLibraryItem", { findMany: async (args: { where?: Where }) => plexLib.filter((r) => matchWhere(r, args.where)) });
shadowPrismaModel(prisma, "jellyfinLibraryItem", { findMany: async (args: { where?: Where }) => jfLib.filter((r) => matchWhere(r, args.where)) });
shadowPrismaModel(prisma, "playHistory", {
  groupBy: async (args: Parameters<typeof groupBy>[1]) => {
    groupByCalls.push({ by: args.by, where: args.where });
    return groupBy(plays, args);
  },
});
shadowPrismaModel(prisma, "activeSession", { findMany: async () => [] });
shadowPrismaModel(prisma, "upstreamWatchEvidence", { findMany: async () => [] });
shadowPrismaModel(prisma, "mediaRequest", { groupBy: async () => [] });
shadowPrismaModel(prisma, "setting", {
  findMany: async (args: { where?: Where }) =>
    [...settings.entries()].map(([key, value]) => ({ key, value })).filter((r) => matchWhere(r, args.where)),
});
shadowPrismaClientMethod(prisma, "$queryRaw", async () => []);

const { loadLibraryWatchFacts } = await import("../src/lib/never-watched-data.ts");

const play = (over: Row): Row => ({
  source: "plex", serverInstance: "", tmdbId: null, mediaType: null, title: "x", seasonNumber: null,
  sourceItemId: null, sourceShowId: null, startedAt: d("2025-08-01"), mediaServerUserId: "msu-1",
  watched: false, completed: false, ...over,
});

beforeEach(() => {
  groupByCalls.length = 0;
  plexLib = [
    { tmdbId: 100, mediaType: "MOVIE", serverInstance: "", title: "Alpha", year: "2020", addedAt: d("2025-03-01"), plexRatingKey: "rk100", plexRatingKeys: ["rk100"] },
    { tmdbId: 300, mediaType: "MOVIE", serverInstance: "", title: "Charlie", year: "2020", addedAt: d("2025-03-01"), plexRatingKey: "rk300", plexRatingKeys: ["rk300"] },
    { tmdbId: 600, mediaType: "TV", serverInstance: "", title: "Foxtrot", year: "2020", addedAt: d("2025-03-01"), plexRatingKey: "rk600", plexRatingKeys: ["rk600"] },
  ];
  jfLib = [
    { tmdbId: 300, mediaType: "MOVIE", serverInstance: "", title: "Charlie", year: "2020", addedAt: d("2025-03-01"), jellyfinItemId: "jf-300", jellyfinItemIds: ["jf-300", "jf-300-dup"] },
  ];
  plays = [
    // Coverage: plex since 2025-01-01, jellyfin since 2025-02-01.
    play({ tmdbId: 999999, mediaType: "MOVIE", startedAt: d("2025-01-01") }),
    play({ source: "jellyfin", tmdbId: 999998, mediaType: "MOVIE", startedAt: d("2025-02-01") }),
    // Charlie's ONLY evidence: a Jellyfin play stored under ANOTHER tmdb id, by
    // the duplicate copy's key — hard evidence through the key read alone (a
    // tmdb id, so never soft-matched by title either).
    play({ source: "jellyfin", tmdbId: 4040, mediaType: "MOVIE", sourceItemId: "jf-300-dup", title: "Charlie (alt)" }),
    // A Plex play under the same KEY string on another source: must not credit
    // Charlie (its jellyfin key), and must not credit anything at all.
    play({ source: "plex", tmdbId: 4041, mediaType: "MOVIE", sourceItemId: "jf-300-dup", title: "Unrelated" }),
  ];
});

const movieKeyRead = () => {
  const calls = groupByCalls.filter((c) => c.by.includes("sourceItemId") && !c.by.includes("title"));
  assert.equal(calls.length, 1, `expected one movie key read: ${JSON.stringify(groupByCalls.map((c) => c.by))}`);
  return calls[0].where ?? {};
};
const sourcesOf = (where: Where) => {
  const s = where.source as { in?: string[] } | undefined;
  return s?.in ? [...s.in].sort() : null;
};

test("C005 a narrowed movie read names the holders' sources — plex+jellyfin for Charlie, plex alone for Alpha", async () => {
  await loadLibraryWatchFacts(null, { now: NOW, only: [{ tmdbId: 300, mediaType: "MOVIE" }] });
  assert.deepEqual(sourcesOf(movieKeyRead()), ["jellyfin", "plex"], "both servers hold Charlie");
  groupByCalls.length = 0;
  await loadLibraryWatchFacts(null, { now: NOW, only: [{ tmdbId: 100, mediaType: "MOVIE" }] });
  assert.deepEqual(sourcesOf(movieKeyRead()), ["plex"], "only Plex holds Alpha — the index's leading column narrows to it");
});

test("C005 the FULL movie read carries no source predicate (14d: evidence is never filtered by source)", async () => {
  await loadLibraryWatchFacts(null, { now: NOW });
  assert.ok(!("source" in movieKeyRead()), JSON.stringify(movieKeyRead()));
});

test("C005 the source scope is lossless: a title whose only hard evidence is a Jellyfin key reaches the full read's verdict", async () => {
  const full = (await loadLibraryWatchFacts(null, { now: NOW })).titles.find((t) => t.tmdbId === 300)!;
  assert.equal(full.verdict.state, "watched", "the full read sees Charlie's Jellyfin key play");
  assert.equal(full.evidence.plays, 1, "the Plex row under the same key string is another server's item");
  const one = (await loadLibraryWatchFacts(null, { now: NOW, only: [{ tmdbId: 300, mediaType: "MOVIE" }] })).titles[0];
  assert.equal(one.verdict.state, full.verdict.state);
  assert.equal(one.evidence.plays, full.evidence.plays);
});

test("C005 a narrowed show read still asks by show key (served by @@index([sourceShowId]))", async () => {
  plays.push(play({ sourceItemId: "ep-601", sourceShowId: "rk600", seasonNumber: 1, title: "Foxtrot" }));
  const one = (await loadLibraryWatchFacts(null, { now: NOW, only: [{ tmdbId: 600, mediaType: "TV" }] })).titles[0];
  assert.equal(one.verdict.state, "watched");
  const show = groupByCalls.find((c) => c.by.includes("sourceShowId") && !c.by.includes("title"));
  assert.deepEqual(show?.where, { sourceShowId: { in: ["rk600"] } });
});
