// Audit fixes for the cleanup library unit (wave B3).
//
// C014 — the title manager's Remove (removeTitle) re-asserts the cleanup stamp
// once the title is gone from the instance. A concurrent removal (or a Library
// cleanup execute) that stamped first owns those rows by ITS time; if its own
// delete is then refused it unstamps them, and the next sync re-downloads a
// title that is gone (guardrail 14b). Re-asserted with this call's time, that
// unstamp misses — and if it already ran, the rows are written back.
//
// Harness: removeTitle called directly over in-memory prisma stubs, Radarr
// scripted on an RFC1918 literal (the tests/arr-title-lifecycle.test.mts idiom).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

const fakeLookup = async () => [{ address: "10.0.0.250", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) throw new Error("could not stub dns.lookup");

console.warn = () => {};
console.error = () => {};

const RADARR = "http://10.0.0.5:7878";
const movie = { id: 11, tmdbId: 603, title: "The Matrix", year: 1999, monitored: true, qualityProfileId: 1, rootFolderPath: "/movies/", path: "/movies/The Matrix (1999)", tags: [], hasFile: true, minimumAvailability: "released", status: "released", sizeOnDisk: 4e9 };
let deleteAnswer: () => Response = () => new Response("", { status: 200 });
let titleStillListed = true;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  if (url.origin !== RADARR) throw new Error(`unexpected ${method} ${url}`);
  if (method === "DELETE" && url.pathname === "/api/v3/movie/11") return deleteAnswer();
  if (method === "GET" && url.pathname === "/api/v3/movie/11") {
    return titleStillListed ? Response.json(movie) : new Response("not found", { status: 404 });
  }
  throw new Error(`unexpected ${method} ${url}`);
}) as unknown as typeof fetch;

const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel } = await import("./_helpers.mts");

const settings = new Map<string, string>([["radarrUrl", RADARR], ["radarrApiKey", "radarr-key"]]);
shadowPrismaModel(prisma, "setting", {
  findMany: async (args?: { where?: { key?: { in?: string[] } } }) => {
    const keys = args?.where?.key?.in;
    return [...settings.entries()].filter(([k]) => !keys || keys.includes(k)).map(([key, value]) => ({ key, value }));
  },
  findUnique: async (args: { where: { key: string } }) => {
    const v = settings.get(args.where.key);
    return v === undefined ? null : { key: args.where.key, value: v };
  },
});

type Req = { id: string; tmdbId: number; tvdbId: number | null; mediaType: string; arrInstance: string; status: string; cleanedUpAt: Date | null };
let requests: Req[] = [];
const matches = (r: Req, where: Record<string, unknown>): boolean => Object.entries(where).every(([k, v]) => {
  if (k === "OR") return (v as Array<Record<string, unknown>>).some((w) => matches(r, w));
  if (v && typeof v === "object" && !(v instanceof Date) && "in" in (v as object)) return ((v as { in: unknown[] }).in).includes((r as unknown as Record<string, unknown>)[k]);
  const field = (r as unknown as Record<string, unknown>)[k];
  if (v instanceof Date) return field instanceof Date && field.getTime() === v.getTime();
  return field === v;
});
const write = (where: Record<string, unknown>, data: { cleanedUpAt: Date | null }) => {
  const hit = requests.filter((x) => matches(x, where));
  for (const r of hit) r.cleanedUpAt = data.cleanedUpAt;
  return hit;
};
shadowPrismaModel(prisma, "mediaRequest", {
  updateManyAndReturn: async (args: { where: Record<string, unknown>; data: { cleanedUpAt: Date | null } }) =>
    write(args.where, args.data).map((r) => ({ id: r.id })),
  updateMany: async (args: { where: Record<string, unknown>; data: { cleanedUpAt: Date | null } }) => ({ count: write(args.where, args.data).length }),
  groupBy: async (args: { where: Record<string, unknown> }) => {
    const by = new Map<string, number>();
    for (const r of requests.filter((x) => matches(x, args.where))) by.set(r.status, (by.get(r.status) ?? 0) + 1);
    return [...by].map(([status, n]) => ({ status, _count: { _all: n } }));
  },
});

const { removeTitle } = await import("../src/lib/arr-title-lifecycle.ts");

const theirs = new Date("2026-10-01T00:00:00.000Z");
const ours = new Date("2026-10-12T00:00:00.000Z");
// The concurrent removal's unstamp, exactly as removeTitle writes it.
const theirUnstamp = () => write({ id: { in: ["a"] }, cleanedUpAt: theirs }, { cleanedUpAt: null });
const opts = { deleteFiles: true, addImportExclusion: false };

beforeEach(() => {
  deleteAnswer = () => new Response("", { status: 200 });
  titleStillListed = true;
  // Stamped by a concurrent removal first: this call finds nothing to own.
  requests = [
    { id: "a", tmdbId: 603, tvdbId: null, mediaType: "MOVIE", arrInstance: "", status: "AVAILABLE", cleanedUpAt: theirs },
    { id: "k", tmdbId: 603, tvdbId: null, mediaType: "MOVIE", arrInstance: "4k", status: "AVAILABLE", cleanedUpAt: null },
  ];
});

test("C014 removeTitle: a removal that went through takes the stamp over, so the other removal's unstamp misses", async () => {
  const res = await removeTitle("radarr", "", 11, opts, ours);
  assert.equal(res?.requestsStamped, 0, "the count is still only what this call stamped first");
  assert.equal(requests[0].cleanedUpAt?.getTime(), ours.getTime(), "re-asserted with this call's time");
  theirUnstamp();
  assert.ok(requests[0].cleanedUpAt instanceof Date, "the title is gone: the stamp must stay");
  assert.equal(requests[1].cleanedUpAt, null, "another instance's request is not this removal's");
});

test("C014 removeTitle: an unstamp that lands while the DELETE is in flight is written back", async () => {
  deleteAnswer = () => {
    theirUnstamp();
    return new Response("", { status: 200 });
  };
  await removeTitle("radarr", "", 11, opts, ours);
  assert.ok(requests[0].cleanedUpAt instanceof Date);
});

test("C014 removeTitle: a 404 (already gone) and a refused delete the re-read shows gone both re-assert", async () => {
  deleteAnswer = () => new Response("gone", { status: 404 });
  const gone = await removeTitle("radarr", "", 11, opts, ours);
  assert.equal(gone?.alreadyGone, true);
  assert.equal(requests[0].cleanedUpAt?.getTime(), ours.getTime());

  requests[0].cleanedUpAt = theirs;
  deleteAnswer = () => {
    titleStillListed = false; // the delete landed, then the answer was an error
    return new Response("boom", { status: 500 });
  };
  const after = await removeTitle("radarr", "", 11, opts, ours);
  assert.equal(after?.alreadyGone, false);
  assert.equal(requests[0].cleanedUpAt?.getTime(), ours.getTime());
});

test("C014 removeTitle: a refused delete with the title still listed re-asserts nothing", async () => {
  deleteAnswer = () => new Response("boom", { status: 500 });
  await assert.rejects(removeTitle("radarr", "", 11, opts, ours));
  assert.equal(requests[0].cleanedUpAt?.getTime(), theirs.getTime(), "not this call's: it removed nothing");
});

// ── C057: upstream failure text the page translates, never prints ────────────
// The cleanup and never-watched pages used to splice English upstream text
// (arrErrorMessage, safeMessage, safeUpstreamError) into translated sentences.
// A Radarr/Sonarr failure now carries an arrErrorKind and a watch-record check
// an UpstreamErrorCode, each worded through a LITERAL key map.
const { readFileSync } = await import("node:fs");
const { safeUpstreamError, upstreamErrorCode, UPSTREAM_ERROR_TEXT } = await import("../src/lib/upstream-watch.ts");
const { arrFailureText, upstreamFailureText, UPSTREAM_ERROR_KEYS } = await import("../src/lib/cleanup-error-text.ts");
const en = JSON.parse(readFileSync(new URL("../src/lib/i18n/messages/en/adminManage.json", import.meta.url), "utf8")) as Record<string, string>;
const fakeT = (key: string, vars?: Readonly<Record<string, string | number>>) => `${key}${vars ? JSON.stringify(vars) : ""}`;

test("C057 upstreamErrorCode: every text the refresh can store maps back to its own code", () => {
  const safeFetch = (reason: string) => Object.assign(new Error(`Request to http://10.0.0.1/?X-Plex-Token=secret ${reason}`), { name: "SafeFetchError", reason });
  for (const [err, code] of [
    [safeFetch("timeout"), "timeout"],
    [safeFetch("network"), "unreachable"],
    [safeFetch("ssrf-blocked"), "blocked"],
    [safeFetch("size"), "tooLarge"],
    [safeFetch("redirect"), "redirect"],
    [new Error("Jellyfin users failed: 503"), "http"],
    [new Error("Jellyfin returned no users"), "noUsers"],
    [new Error("no MediaContainer in the answer"), "shape"],
    [new Error("boom"), "other"],
  ] as const) {
    assert.equal(upstreamErrorCode(safeUpstreamError(err))?.code, code, String(err));
  }
  assert.deepEqual(upstreamErrorCode("HTTP 401"), { code: "http", httpStatus: 401 });
  for (const [code, text] of Object.entries(UPSTREAM_ERROR_TEXT)) assert.deepEqual(upstreamErrorCode(text), { code, httpStatus: null });
  assert.deepEqual(upstreamErrorCode("worded by an older build"), { code: "other", httpStatus: null }, "unknown text still reads as a failure");
  assert.equal(upstreamErrorCode(null), null);
});

test("C057 UPSTREAM_ERROR_KEYS: one English message per code", () => {
  const codes = [...Object.keys(UPSTREAM_ERROR_TEXT), "http"].sort();
  assert.deepEqual(Object.keys(UPSTREAM_ERROR_KEYS).sort(), codes);
  for (const key of Object.values(UPSTREAM_ERROR_KEYS)) assert.ok(typeof en[key] === "string" && en[key].length > 0, `${key} is in en/adminManage.json`);
  assert.match(en[UPSTREAM_ERROR_KEYS.http], /\{status\}/);
});

test("C057 upstreamFailureText / arrFailureText: translated by code, the stored English only as a fallback", () => {
  assert.equal(upstreamFailureText(fakeT, { error: "timed out", errorCode: "timeout", httpStatus: null }), UPSTREAM_ERROR_KEYS.timeout);
  assert.equal(upstreamFailureText(fakeT, { error: "HTTP 401", errorCode: "http", httpStatus: 401 }), `${UPSTREAM_ERROR_KEYS.http}{"status":401}`);
  assert.equal(upstreamFailureText(fakeT, { error: "timed out" }), "timed out", "a response without a code keeps its text");
  assert.equal(arrFailureText(fakeT, "Radarr (4k)", { kind: "auth", error: "Arr authentication failed (401)" }), `adminArr.error.auth{"name":"Radarr (4k)"}`);
  assert.equal(arrFailureText(fakeT, "Sonarr", { error: "boom" }), "Sonarr (boom)");
});

test("C057: the three pages word upstream failures through the shared helpers, never the raw English", () => {
  const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
  const cleanup = read("src/components/admin/library-cleanup.tsx");
  const nw = read("src/components/admin/never-watched-report.tsx");
  const del = read("src/components/admin/cleanup-delete.tsx");
  for (const [name, src] of [["library-cleanup", cleanup], ["never-watched-report", nw]] as const) {
    assert.match(src, /arrErrors\.map\(\(e\) => arrFailureText\(t, /, `${name}: the arr banner goes through arrFailureText`);
    assert.doesNotMatch(src, /\(\$\{e\.error\}\)/, `${name}: no raw e.error in a sentence`);
  }
  assert.match(nw, /upstreamFailureText\(t, u\)/);
  assert.doesNotMatch(nw, /\{u\.error\}/, "the stored English upstream text is never rendered");
  assert.match(del, /arrFailureText\(t, /);
  assert.doesNotMatch(del, /\$\{f\.target\}: \$\{f\.error\}/);
});
