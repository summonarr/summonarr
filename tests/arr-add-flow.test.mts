// The add path shared by addMovieToRadarr and addSeriesToSonarr (src/lib/arr.ts):
// the requester tag and the POST's duplicate / path-collision handling.
//
//   - REQUESTER TAG: concurrent adds for one requester (a batch approve runs
//     several at once) share ONE find-or-create. Each used to read the tag list,
//     miss the new label and POST it, so the arr held duplicate tags or refused
//     the later POSTs and those titles went in untagged. A POST that fails is
//     followed by one re-read, so a tag someone else created meanwhile is used.
//     Tagging stays best-effort: no tag is an untagged add, never a failed one.
//   - PATH COLLISION: a 400 from MoviePathValidator / SeriesPathValidator (a
//     DIFFERENT title owns the `Title (Year)` folder) is retried ONCE at
//     `<path> {tmdb-<id>}` / `{tvdb-<id>}`; "already added" on either attempt
//     runs the duplicate remediation (re-monitor + search); anything else is
//     rethrown without a retry.
//
// No DB, no network: prisma.setting/user/tmdbCache are shadowed in-memory,
// dns.lookup is stubbed, both arrs are RFC1918 IP literals, and
// globalThis.fetch is scripted per test.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";

process.env.NEXTAUTH_SECRET ??= "unit-test-session-secret-0123456789abcdef";
process.env.TOKEN_ENCRYPTION_KEY ??= "ab".repeat(32);
process.env.DATABASE_URL ??= "postgresql://unit:unit@127.0.0.1:9/never_connects";
delete process.env.TMDB_READ_TOKEN;

const fakeLookup = async () => [{ address: "93.184.216.34", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) {
  throw new Error("could not stub dns.lookup — aborting before a real DNS query can leave the process");
}

const warns: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
console.error = () => {};

// ── scripted Radarr / Sonarr ────────────────────────────────────────────────
type Call = { url: URL; method: string; body?: string };
const calls: Call[] = [];
let tags: Array<{ id: number; label: string }> = [];
let nextTagId = 7;
// How a POST /api/v3/tag is answered: create the tag, or fail (optionally
// after someone else created it).
let tagPost: "create" | "fail" | "fail-but-created" = "create";
// Answers for POST /api/v3/movie|series, in order; then 201.
let addAnswers: Response[] = [];
let existingMovie: Record<string, unknown> | null = null;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
const collision = (errorCode: string, path: string) =>
  json([{ propertyName: "Path", errorMessage: `Path '${path}' is already configured for an existing item`, errorCode, formattedMessagePlaceholderValues: { path } }], 400);
const alreadyAdded = () => json([{ propertyName: "TmdbId", errorMessage: "This movie has already been added" }], 400);

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" ? init.body : undefined;
  calls.push({ url, method, body });
  if (url.pathname === "/api/v3/tag" && method === "GET") return json(tags);
  if (url.pathname === "/api/v3/tag" && method === "POST") {
    const label = (JSON.parse(body!) as { label: string }).label;
    if (tagPost === "fail") return json({ message: "boom" }, 500);
    const created = { id: nextTagId++, label };
    tags = [...tags, created];
    return tagPost === "fail-but-created" ? json({ message: "conflict" }, 409) : json(created);
  }
  if (url.pathname === "/api/v3/movie/lookup") {
    return json([{ title: "The Matrix", tmdbId: 603, year: 1999, images: [], titleSlug: "the-matrix-603", status: "released" }]);
  }
  if (url.pathname === "/api/v3/series/lookup") {
    return json([{ title: "Game of Thrones", tvdbId: 121361, tmdbId: 1399, year: 2011, images: [], titleSlug: "game-of-thrones", seasons: [{ seasonNumber: 0, monitored: false }, { seasonNumber: 1, monitored: true }], firstAired: "2011-04-17T00:00:00Z", status: "ended" }]);
  }
  if ((url.pathname === "/api/v3/movie" || url.pathname === "/api/v3/series") && method === "POST") {
    return addAnswers.shift() ?? json({ id: 1 }, 201);
  }
  if (url.pathname === "/api/v3/movie" && method === "GET") return json(existingMovie ? [existingMovie] : []);
  if (url.pathname.startsWith("/api/v3/movie/") && method === "PUT") return json(JSON.parse(body!));
  if (url.pathname === "/api/v3/command" && method === "POST") return json({ id: 99 });
  throw new Error(`unexpected fetch ${method} ${url}`);
}) as unknown as typeof fetch;

const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel } = await import("./_helpers.mts");

const settings = new Map<string, string>();
shadowPrismaModel(prisma, "setting", {
  findMany: async (args: { where: { key: { in: string[] } } }) =>
    args.where.key.in.filter((k) => settings.has(k)).map((k) => ({ key: k, value: settings.get(k)! })),
  findUnique: async (args: { where: { key: string } }) => {
    const value = settings.get(args.where.key);
    return value === undefined ? null : { key: args.where.key, value };
  },
});
shadowPrismaModel(prisma, "user", {
  findUnique: async () => ({ name: "Chris Burton", email: "chris@example.com" }),
});
shadowPrismaModel(prisma, "tmdbCache", {
  findUnique: async () => null,
  findMany: async () => [],
  upsert: async () => ({}),
  deleteMany: async () => ({ count: 0 }),
});

const { addMovieToRadarr, addSeriesToSonarr, ArrResponseError } = await import("../src/lib/arr.ts");
const { arrRequesterTagLabel } = await import("../src/lib/arr-tags.ts");

const LABEL = arrRequesterTagLabel("Chris Burton", "chris@example.com", "user-0001");
let instance = 0;
beforeEach(() => {
  calls.length = 0;
  warns.length = 0;
  tags = [];
  nextTagId = 7;
  tagPost = "create";
  addAnswers = [];
  existingMovie = null;
  settings.clear();
  // A fresh Radarr per test: the tag find-or-create is keyed by the instance URL.
  instance += 1;
  settings.set("radarrUrl", `http://10.0.8.${instance}:7878`);
  settings.set("radarrApiKey", "radarr-key");
  settings.set("radarrRootFolder", "/movies");
  settings.set("radarrQualityProfileId", "1");
  settings.set("sonarrUrl", `http://10.0.9.${instance}:8989`);
  settings.set("sonarrApiKey", "sonarr-key");
  settings.set("sonarrRootFolder", "/tv");
  settings.set("sonarrQualityProfileId", "1");
});

const posts = (path: string) => calls.filter((c) => c.method === "POST" && c.url.pathname === path);
const bodyOf = (c: Call) => JSON.parse(c.body!) as Record<string, unknown>;

// ═══ requester tag ═══════════════════════════════════════════════════════════

test("tag: concurrent adds for one new requester create the tag ONCE and both adds carry it", async () => {
  await Promise.all([
    addMovieToRadarr(603, "", undefined, "user-0001"),
    addMovieToRadarr(603, "", undefined, "user-0001"),
  ]);
  assert.equal(posts("/api/v3/tag").length, 1, "one find-or-create for the label");
  assert.deepEqual(tags, [{ id: 7, label: LABEL }], "no duplicate tag in the arr");
  const adds = posts("/api/v3/movie");
  assert.equal(adds.length, 2);
  for (const add of adds) assert.deepEqual(bodyOf(add).tags, [7]);
  assert.deepEqual(warns, []);
});

test("tag: once settled, a later add finds the existing tag (case-insensitive) and POSTs nothing", async () => {
  tags = [{ id: 3, label: LABEL.toUpperCase() }];
  await addMovieToRadarr(603, "", undefined, "user-0001");
  assert.equal(posts("/api/v3/tag").length, 0);
  assert.deepEqual(bodyOf(posts("/api/v3/movie")[0]).tags, [3]);
});

test("tag: a refused POST re-reads the list and uses the tag someone else just created", async () => {
  tagPost = "fail-but-created";
  await addMovieToRadarr(603, "", undefined, "user-0001");
  assert.equal(posts("/api/v3/tag").length, 1);
  assert.equal(calls.filter((c) => c.method === "GET" && c.url.pathname === "/api/v3/tag").length, 2, "the list is read again after the refusal");
  assert.deepEqual(bodyOf(posts("/api/v3/movie")[0]).tags, [7]);
  assert.deepEqual(warns, []);
});

test("tag: a refused POST with no tag on the re-read adds UNTAGGED — never a failed add", async () => {
  tagPost = "fail";
  await addMovieToRadarr(603, "", undefined, "user-0001");
  const add = bodyOf(posts("/api/v3/movie")[0]);
  assert.equal("tags" in add, false, "no `tags` field when there is no tag");
  assert.ok(warns.some((w) => w.includes("requester-tag ensure failed")), warns.join(" | "));
});

// ═══ path collision / duplicate ══════════════════════════════════════════════

test("collision: a MoviePathValidator 400 is retried ONCE at the {tmdb-<id>} path", async () => {
  addAnswers = [collision("MoviePathValidator", "/movies/The Matrix (1999)")];
  await addMovieToRadarr(603);
  const adds = posts("/api/v3/movie");
  assert.equal(adds.length, 2);
  assert.equal("path" in bodyOf(adds[0]), false, "the first attempt names no path");
  assert.equal(bodyOf(adds[1]).path, "/movies/The Matrix (1999) {tmdb-603}");
  assert.equal(bodyOf(adds[1]).rootFolderPath, "/movies");
});

test("collision: 'already added' on the retry runs the duplicate remediation — re-monitor and search", async () => {
  addAnswers = [collision("MoviePathValidator", "/movies/The Matrix (1999)"), alreadyAdded()];
  existingMovie = { id: 5, tmdbId: 603, monitored: false, hasFile: false, title: "The Matrix" };
  await addMovieToRadarr(603);
  assert.equal(posts("/api/v3/movie").length, 2, "no third attempt");
  const put = calls.find((c) => c.method === "PUT");
  assert.equal(put?.url.pathname, "/api/v3/movie/5");
  assert.equal(bodyOf(put!).monitored, true);
  assert.deepEqual(posts("/api/v3/command").map(bodyOf), [{ name: "MoviesSearch", movieIds: [5] }]);
  assert.ok(warns.some((w) => w.includes("movie already in Radarr")));
});

test("collision: 'already added' on the FIRST attempt remediates without a retry", async () => {
  addAnswers = [alreadyAdded()];
  existingMovie = { id: 5, tmdbId: 603, monitored: true, hasFile: false };
  await addMovieToRadarr(603);
  assert.equal(posts("/api/v3/movie").length, 1);
  assert.equal(calls.filter((c) => c.method === "PUT").length, 0, "already monitored: left as it is");
});

test("collision: any other refusal is rethrown with no retry, and a failed retry is rethrown too", async () => {
  addAnswers = [json([{ propertyName: "QualityProfileId", errorMessage: "Invalid profile" }], 400)];
  await assert.rejects(addMovieToRadarr(603), (e: unknown) => e instanceof ArrResponseError && e.status === 400);
  assert.equal(posts("/api/v3/movie").length, 1);

  calls.length = 0;
  addAnswers = [collision("MoviePathValidator", "/movies/The Matrix (1999)"), json({ message: "boom" }, 500)];
  await assert.rejects(addMovieToRadarr(603), (e: unknown) => e instanceof ArrResponseError && e.status === 500);
  assert.equal(posts("/api/v3/movie").length, 2);
});

test("collision: Sonarr's SeriesPathValidator is retried at the {tvdb-<id>} path and the add still answers the tvdbId", async () => {
  addAnswers = [collision("SeriesPathValidator", "/tv/Game of Thrones")];
  assert.equal(await addSeriesToSonarr(1399), 121361);
  const adds = posts("/api/v3/series");
  assert.equal(adds.length, 2);
  assert.equal(bodyOf(adds[1]).path, "/tv/Game of Thrones {tvdb-121361}");
  assert.deepEqual(bodyOf(adds[1]).seasons, [{ seasonNumber: 0, monitored: false }, { seasonNumber: 1, monitored: true }]);
});
