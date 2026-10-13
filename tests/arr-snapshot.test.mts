// "Instant, then live" for the admin Radarr/Sonarr pages: the server keeps the
// last successful answer of each admin arr read (src/lib/arr-snapshot.ts) and a
// page paints it at once via `?cached=1` before its live load lands
// (src/lib/client/arr-snapshot.ts). A snapshot is display only.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import {
  SNAPSHOT_HEADER,
  SNAPSHOT_MAX_AGE_MS,
  SNAPSHOT_MAX_BYTES,
  SNAPSHOT_MAX_ENTRY_BYTES,
  arrSnapshotStats,
  clearArrSnapshots,
  readSnapshot,
  rememberSnapshot,
  snapshotKey,
  snapshotted,
} from "../src/lib/arr-snapshot.ts";
import { cachedUrl, readArrSnapshot, SNAPSHOT_HEADER as CLIENT_HEADER } from "../src/lib/client/arr-snapshot.ts";

beforeEach(() => clearArrSnapshots());

test("one header name on both sides", () => {
  assert.equal(SNAPSHOT_HEADER, CLIENT_HEADER);
});

test("key: path + sorted query + language; the `cached` switch is not part of what was read; a job poll is never keyed", () => {
  const a = snapshotKey("http://x/api/admin/arr/history?service=sonarr&instance=4k&page=2", "en");
  const b = snapshotKey("http://x/api/admin/arr/history?page=2&instance=4k&service=sonarr&cached=1", "en");
  assert.equal(a, b);
  assert.notEqual(a, snapshotKey("http://x/api/admin/arr/history?service=sonarr&instance=4k&page=3", "en"), "another page is another snapshot");
  assert.notEqual(a, snapshotKey("http://x/api/admin/arr/history?service=sonarr&instance=4k&page=2", "fr"), "bodies can carry translated text");
  assert.equal(snapshotKey("http://x/api/admin/arr/title/files?service=sonarr&id=2&job=abc", "en"), null);
});

test("LRU by bytes: the oldest-used answers go first; an over-size answer is not kept and drops its older copy", () => {
  const big = "x".repeat(SNAPSHOT_MAX_ENTRY_BYTES); // exactly at the cap: kept
  const fit = Math.floor(SNAPSHOT_MAX_BYTES / SNAPSHOT_MAX_ENTRY_BYTES);
  for (let i = 0; i < fit; i++) rememberSnapshot(`k${i}`, big, 1000);
  assert.equal(arrSnapshotStats().entries, fit);
  assert.ok(readSnapshot("k0", 1000), "touching k0 makes it the most recently used");
  rememberSnapshot("new", big, 1000);
  assert.ok(arrSnapshotStats().bytes <= SNAPSHOT_MAX_BYTES);
  assert.equal(readSnapshot("k1", 1000), null, "the least recently used answer was evicted");
  assert.ok(readSnapshot("k0", 1000), "the touched one survived");

  rememberSnapshot("k0", "y".repeat(SNAPSHOT_MAX_ENTRY_BYTES + 1), 1000);
  assert.equal(readSnapshot("k0", 1000), null, "an over-size answer drops the older copy instead of keeping a stale one");
});

test("an answer older than the maximum age is never painted", () => {
  rememberSnapshot("k", "{}", 0);
  assert.ok(readSnapshot("k", SNAPSHOT_MAX_AGE_MS));
  assert.equal(readSnapshot("k", SNAPSHOT_MAX_AGE_MS + 1), null);
  assert.equal(arrSnapshotStats().entries, 0, "and it is dropped");
});

function req(url: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(url, { headers: { "accept-language": "en", ...headers } });
}

test("wrapper: cached=1 answers 204 when nothing is kept, WITHOUT running the handler", async () => {
  let ran = 0;
  const GET = snapshotted(async () => {
    ran++;
    return Response.json({ rows: [1] });
  });
  const res = await GET(req("http://x/api/admin/queue?cached=1"), {}, {});
  assert.equal(res.status, 204);
  assert.equal(ran, 0, "a snapshot read never reaches Radarr/Sonarr");
});

test("wrapper: a live 200 JSON is kept byte-for-byte and served with its read time; the live answer itself is untouched", async () => {
  const body = { rows: [{ id: 1, title: "Dune" }], errors: [] };
  const GET = snapshotted(async () => Response.json(body));
  const live = await GET(req("http://x/api/admin/queue"), {}, {});
  assert.deepEqual(await live.json(), body, "the live response is still readable after the copy");
  const cached = await GET(req("http://x/api/admin/queue?cached=1"), {}, {});
  assert.equal(cached.status, 200);
  assert.deepEqual(await cached.json(), body);
  const at = cached.headers.get(SNAPSHOT_HEADER);
  assert.ok(at && !Number.isNaN(Date.parse(at)));
  assert.equal(cached.headers.get("cache-control"), "no-store");
});

test("wrapper: a failed read never replaces the last good answer (an arr that is down keeps it on screen)", async () => {
  let status = 200;
  const GET = snapshotted(async () => (status === 200 ? Response.json({ ok: 1 }) : Response.json({ error: "Sonarr didn't answer" }, { status })));
  await GET(req("http://x/api/admin/missing?service=sonarr"), {}, {});
  status = 502;
  await GET(req("http://x/api/admin/missing?service=sonarr"), {}, {});
  status = 504;
  await GET(req("http://x/api/admin/missing?service=sonarr"), {}, {});
  const cached = await GET(req("http://x/api/admin/missing?service=sonarr&cached=1"), {}, {});
  assert.deepEqual(await cached.json(), { ok: 1 });
});

test("wrapper: languages don't cross, and a job poll is neither kept nor served", async () => {
  const GET = snapshotted(async (r: NextRequest) => Response.json({ lang: r.headers.get("accept-language") }));
  await GET(req("http://x/api/admin/arr/tasks", { "accept-language": "fr" }), {}, {});
  assert.equal((await GET(req("http://x/api/admin/arr/tasks?cached=1", { "accept-language": "en" }), {}, {})).status, 204);
  assert.deepEqual(await (await GET(req("http://x/api/admin/arr/tasks?cached=1", { "accept-language": "fr" }), {}, {})).json(), { lang: "fr" });

  const before = arrSnapshotStats().entries;
  await GET(req("http://x/api/admin/arr/title/files?id=2&job=0123"), {}, {});
  assert.equal(arrSnapshotStats().entries, before, "a job poll answers the job, not the page");
  assert.equal((await GET(req("http://x/api/admin/arr/title/files?id=2&job=0123&cached=1"), {}, {})).status, 204);
});

// --- client half -----------------------------------------------------------

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("client: cachedUrl appends the switch to either URL shape", () => {
  assert.equal(cachedUrl("/api/admin/queue"), "/api/admin/queue?cached=1");
  assert.equal(cachedUrl("/api/admin/missing?service=sonarr"), "/api/admin/missing?service=sonarr&cached=1");
});

test("client: a snapshot comes back with its read time; 204, a non-snapshot 200, a bad date and a network failure are all 'none'", async () => {
  const seen: string[] = [];
  let answer: () => Response = () => new Response(null, { status: 204 });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    seen.push(String(input));
    return answer();
  }) as typeof fetch;

  assert.equal(await readArrSnapshot("/api/admin/queue"), null);
  assert.deepEqual(seen, ["/api/admin/queue?cached=1"]);

  answer = () => new Response(JSON.stringify({ rows: [] }), { status: 200, headers: { [SNAPSHOT_HEADER]: "2026-10-13T10:00:00.000Z" } });
  assert.deepEqual(await readArrSnapshot("/api/admin/queue"), { data: { rows: [] }, at: "2026-10-13T10:00:00.000Z" });

  answer = () => new Response(JSON.stringify({ rows: [] }), { status: 200 });
  assert.equal(await readArrSnapshot("/api/admin/queue"), null, "a 200 without the header is not a snapshot");

  answer = () => new Response(JSON.stringify({ rows: [] }), { status: 200, headers: { [SNAPSHOT_HEADER]: "not a date" } });
  assert.equal(await readArrSnapshot("/api/admin/queue"), null);

  answer = () => {
    throw new TypeError("fetch failed");
  };
  assert.equal(await readArrSnapshot("/api/admin/queue"), null, "never throws");
});

// --- invalidation and the hook's decline -------------------------------------

import { readFileSync } from "node:fs";
import { isArrConfigKey } from "../src/lib/arr-snapshot.ts";

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\/\/.*$/gm, "");

test("a Radarr/Sonarr connection key or integration switch is arr config; other settings are not", () => {
  for (const k of ["radarrUrl", "radarrApiKey", "radarr4kUrl", "radarrAnimeApiKey", "sonarrUrl", "sonarrQualityProfileId", "feature.integration.radarr", "feature.integration.sonarr"]) {
    assert.ok(isArrConfigKey(k), k);
  }
  for (const k of ["plexUrl", "jellyfinApiKey", "feature.admin.cleanup", "arrWatchDiskLowPercent", "tmdbReadToken"]) {
    assert.ok(!isArrConfigKey(k), k);
  }
});

test("config writes drop every snapshot: a cached read never runs its route's own instance checks", () => {
  const settings = src("src/app/api/settings/route.ts");
  assert.match(settings, /const arrConfigChanged = changedKeys\.some\(isArrConfigKey\);\s*if \(arrConfigChanged\) clearArrSnapshots\(\);/);
  assert.match(settings, /if \(neverWatchedInputChanged\) invalidateNeverWatchedReport\(\);\s*if \(arrConfigChanged\) clearArrSnapshots\(\);/, "the rollback path drops them too");
  assert.equal((settings.match(/clearArrSnapshots\(\)/g) ?? []).length, 2, "the write path and the rollback path");
  const instances = src("src/app/api/admin/arr-instances/route.ts");
  assert.match(instances, /clearArrSnapshots\(\);\s*void logAudit\(/);
});

test("the hook shows the stale note only for a snapshot the page actually drew", () => {
  const hook = src("src/components/admin/use-arr-snapshot.ts");
  assert.match(hook, /apply: \(data: T\) => boolean \| void/);
  assert.match(hook, /if \(applyRef\.current\(snap\.data\) === false\) return;\s*setShown\(\{ url, at: snap\.at \}\);/);
  assert.match(hook, /if \(!snap \|\| ctl\.signal\.aborted \|\| liveFor\.current === url\) return;/, "a live answer that beat the snapshot always wins");
});
