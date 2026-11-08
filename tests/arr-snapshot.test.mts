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
  dropArrTitleSnapshots,
  readSnapshot,
  rememberSnapshot,
  snapshotKey,
  snapshotted,
} from "../src/lib/arr-snapshot.ts";

// A session the wrapped handlers may read (snapshotted requires SummonarrSession's shape).
const ADMIN_SESSION = { user: { id: "admin-1", role: "ADMIN", permissions: BigInt(0) } };
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

test("the total budget is charged what a body costs in memory: two bytes a character once any is past U+00FF", () => {
  rememberSnapshot("ascii", "x".repeat(1000), 1000);
  assert.equal(arrSnapshotStats().bytes, 1000, "an ASCII body is charged its length");
  clearArrSnapshots();
  // 250 masks of 3 UTF-8 bytes each, plus ASCII: V8 holds the whole string two-byte.
  const masked = `${"•".repeat(250)}${"a".repeat(750)}`;
  assert.equal(Buffer.byteLength(masked, "utf8"), 1500);
  rememberSnapshot("masked", masked, 1000);
  assert.equal(arrSnapshotStats().bytes, 2000, "1,000 characters held as 2,000 bytes, not the 1,500 on the wire");
  // CJK: three UTF-8 bytes a character is more than its two in memory — the larger is charged.
  clearArrSnapshots();
  rememberSnapshot("cjk", "字".repeat(100), 1000);
  assert.equal(arrSnapshotStats().bytes, 300);
  clearArrSnapshots();
  // The LRU evicts by the charge: answers that fit on the wire but not in memory don't all stay.
  const half = Math.floor(SNAPSHOT_MAX_ENTRY_BYTES / 2);
  const twoByte = `•${"b".repeat(half - 1)}`; // ~half the cap on the wire, a whole cap in memory
  assert.ok(Buffer.byteLength(twoByte, "utf8") <= SNAPSHOT_MAX_ENTRY_BYTES);
  const fit = Math.floor(SNAPSHOT_MAX_BYTES / (twoByte.length * 2));
  for (let i = 0; i <= fit; i++) rememberSnapshot(`t${i}`, twoByte, 1000);
  assert.ok(arrSnapshotStats().bytes <= SNAPSHOT_MAX_BYTES);
  assert.equal(arrSnapshotStats().entries, fit, "one more than fits by the charge evicts the oldest");
  assert.equal(readSnapshot("t0", 1000), null);
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
  const res = await GET(req("http://x/api/admin/queue?cached=1"), {}, ADMIN_SESSION);
  assert.equal(res.status, 204);
  assert.equal(ran, 0, "a snapshot read never reaches Radarr/Sonarr");
});

test("wrapper: a live 200 JSON is kept byte-for-byte and served with its read time; the live answer itself is untouched", async () => {
  const body = { rows: [{ id: 1, title: "Dune" }], errors: [] };
  const GET = snapshotted(async () => Response.json(body));
  const live = await GET(req("http://x/api/admin/queue"), {}, ADMIN_SESSION);
  assert.deepEqual(await live.json(), body, "the live response is still readable after the copy");
  const cached = await GET(req("http://x/api/admin/queue?cached=1"), {}, ADMIN_SESSION);
  assert.equal(cached.status, 200);
  assert.deepEqual(await cached.json(), body);
  const at = cached.headers.get(SNAPSHOT_HEADER);
  assert.ok(at && !Number.isNaN(Date.parse(at)));
  assert.equal(cached.headers.get("cache-control"), "no-store");
});

test("wrapper: a failed read never replaces the last good answer (an arr that is down keeps it on screen)", async () => {
  let status = 200;
  const GET = snapshotted(async () => (status === 200 ? Response.json({ ok: 1 }) : Response.json({ error: "Sonarr didn't answer" }, { status })));
  await GET(req("http://x/api/admin/missing?service=sonarr"), {}, ADMIN_SESSION);
  status = 502;
  await GET(req("http://x/api/admin/missing?service=sonarr"), {}, ADMIN_SESSION);
  status = 504;
  await GET(req("http://x/api/admin/missing?service=sonarr"), {}, ADMIN_SESSION);
  const cached = await GET(req("http://x/api/admin/missing?service=sonarr&cached=1"), {}, ADMIN_SESSION);
  assert.deepEqual(await cached.json(), { ok: 1 });
});

test("wrapper: languages don't cross, and a job poll is neither kept nor served", async () => {
  const GET = snapshotted(async (r: NextRequest) => Response.json({ lang: r.headers.get("accept-language") }));
  await GET(req("http://x/api/admin/arr/tasks", { "accept-language": "fr" }), {}, ADMIN_SESSION);
  assert.equal((await GET(req("http://x/api/admin/arr/tasks?cached=1", { "accept-language": "en" }), {}, ADMIN_SESSION)).status, 204);
  assert.deepEqual(await (await GET(req("http://x/api/admin/arr/tasks?cached=1", { "accept-language": "fr" }), {}, ADMIN_SESSION)).json(), { lang: "fr" });

  const before = arrSnapshotStats().entries;
  await GET(req("http://x/api/admin/arr/title/files?id=2&job=0123"), {}, ADMIN_SESSION);
  assert.equal(arrSnapshotStats().entries, before, "a job poll answers the job, not the page");
  assert.equal((await GET(req("http://x/api/admin/arr/title/files?id=2&job=0123&cached=1"), {}, ADMIN_SESSION)).status, 204);
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
  // The connection tests run before the write, so there is no rollback to undo:
  // one drop, after the commit.
  assert.equal((settings.match(/clearArrSnapshots\(\)/g) ?? []).length, 1, "the write path only");
  assert.ok(settings.indexOf("clearArrSnapshots()") > settings.indexOf("await prisma.$transaction("), "after the commit");
  const instances = src("src/app/api/admin/arr-instances/route.ts");
  // Cleared before the audit write; the 4K visibility memo is dropped beside it.
  assert.match(instances, /clearArrSnapshots\(\);(?:\s*\/\/[^\n]*)*\s*invalidateShow4kVisibilityCache\(\);\s*void logAudit\(/);
});

test("dropArrTitleSnapshots drops every title-manager view of that title on that instance, in every language — nothing else", () => {
  const views = [
    "http://x/api/admin/arr/title?service=radarr&instance=&id=7",
    "http://x/api/admin/arr/title?service=radarr&id=007",
    "http://x/api/admin/arr/title?service=radarr&instance=&tmdbId=603",
    "http://x/api/admin/arr/title/files?service=radarr&instance=&id=7",
    "http://x/api/admin/arr/title/history?service=radarr&instance=&id=7",
    "http://x/base/api/admin/arr/title/history?service=radarr&instance=&id=7",
  ];
  const kept = [
    "http://x/api/admin/arr/title?service=radarr&instance=&id=8",
    "http://x/api/admin/arr/title?service=radarr&instance=4k&id=7",
    "http://x/api/admin/arr/title?service=sonarr&instance=&id=7",
    "http://x/api/admin/arr/title/files?service=radarr&instance=&tmdbId=603",
    "http://x/api/admin/arr/history?service=radarr&instance=&id=7",
    "http://x/api/admin/queue",
  ];
  for (const u of [...views, ...kept]) for (const lang of ["en", "fr"]) rememberSnapshot(snapshotKey(u, lang)!, "{}");
  assert.equal(dropArrTitleSnapshots({ service: "radarr", instance: "", arrId: 7, tmdbId: 603 }), views.length * 2);
  for (const u of views) assert.equal(readSnapshot(snapshotKey(u, "fr")!), null, u);
  for (const u of kept) assert.ok(readSnapshot(snapshotKey(u, "en")!), u);
  assert.equal(arrSnapshotStats().entries, kept.length * 2);

  // A Sonarr series' season episodes; a title with no tmdb id matches by its arr id only.
  rememberSnapshot(snapshotKey("http://x/api/admin/arr/title/episodes?service=sonarr&instance=anime&id=21&season=1", "en")!, "{}");
  rememberSnapshot(snapshotKey("http://x/api/admin/arr/title?service=sonarr&instance=anime&tmdbId=0", "en")!, "{}");
  assert.equal(dropArrTitleSnapshots({ service: "sonarr", instance: "anime", arrId: 21, tmdbId: null }), 1);
});

test("a live read that was out across an invalidation keeps nothing — a clear, or its title dropped — but still answers", async () => {
  // Each read is held open until released, so the invalidation lands while it is out.
  const held: Array<() => void> = [];
  const GET = snapshotted(async () => {
    await new Promise<void>((resolve) => held.push(resolve));
    return Response.json({ rows: ["before"] });
  });
  const waitHeld = async (n: number) => {
    while (held.length < n) await new Promise((r) => setImmediate(r));
  };

  // A config write's clear while the queue read is out.
  const queue = GET(req("http://x/api/admin/queue"), {}, ADMIN_SESSION);
  await waitHeld(1);
  clearArrSnapshots();
  held[0]();
  const live = await queue;
  assert.deepEqual(await live.json(), { rows: ["before"] }, "the live answer goes back unchanged");
  assert.equal(readSnapshot(snapshotKey("http://x/api/admin/queue", "en")!), null, "but it is not kept");

  // The title manager's Remove while that title's read is out.
  const title = GET(req("http://x/api/admin/arr/title?service=radarr&instance=&id=7"), {}, ADMIN_SESSION);
  await waitHeld(2);
  rememberSnapshot(snapshotKey("http://x/api/admin/arr/title/files?service=radarr&instance=&id=7", "en")!, "{}");
  assert.equal(dropArrTitleSnapshots({ service: "radarr", instance: "", arrId: 7, tmdbId: null }), 1);
  held[1]();
  assert.equal((await title).status, 200);
  assert.equal(readSnapshot(snapshotKey("http://x/api/admin/arr/title?service=radarr&instance=&id=7", "en")!), null, "the removed title's read is not put back");

  // A drop that dropped nothing invalidates nothing: a read out across it is kept.
  const other = GET(req("http://x/api/admin/queue?page=2"), {}, ADMIN_SESSION);
  await waitHeld(3);
  assert.equal(dropArrTitleSnapshots({ service: "sonarr", instance: "", arrId: 999, tmdbId: null }), 0);
  held[2]();
  await other;
  assert.ok(readSnapshot(snapshotKey("http://x/api/admin/queue?page=2", "en")!));

  // And a read with no invalidation while it was out is kept as before.
  const plain = GET(req("http://x/api/admin/queue?page=3"), {}, ADMIN_SESSION);
  await waitHeld(4);
  held[3]();
  await plain;
  assert.ok(readSnapshot(snapshotKey("http://x/api/admin/queue?page=3", "en")!));
});

test("the title manager's Remove drops the removed title's views once the arr took it off", () => {
  const remove = src("src/app/api/admin/arr/title/remove/route.ts");
  assert.match(
    remove,
    /if \(!result\) return NextResponse\.json\([^\n]+\{ status: 404 \}\);\s*invalidateArrLibraryIndexCache\(\);\s*invalidateNeverWatchedReport\(\);\s*dropArrTitleSnapshots\(\{ service: target\.service, instance: target\.instance, arrId: target\.arrId, tmdbId: result\.title\.tmdbId \}\);/,
  );
  assert.equal((remove.match(/dropArrTitleSnapshots\(/g) ?? []).length, 1, "only after a removal the arr accepted");
});

test("the hook shows the stale note only for a snapshot the page actually drew", () => {
  const hook = src("src/components/admin/use-arr-snapshot.ts");
  assert.match(hook, /apply: \(data: T\) => boolean \| void/);
  assert.match(hook, /if \(applyRef\.current\(snap\.data\) === false\) return;\s*setShown\(\{ url, at: snap\.at \}\);/);
  assert.match(hook, /if \(!snap \|\| ctl\.signal\.aborted \|\| liveFor\.current === url\) return;/, "a live answer that beat the snapshot always wins");
});

test("client: a parse that refuses the body makes it 'no snapshot'; one that accepts it hands back its own value", async () => {
  const { v, check } = await import("../src/lib/validate.ts");
  const schema = v.object({ rows: v.array(v.unknown()) });
  const parse = (data: unknown) => {
    const r = check(schema, data);
    return r.ok ? r.value : null;
  };
  let body: unknown = { rows: [1], extra: true };
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), { status: 200, headers: { [SNAPSHOT_HEADER]: "2026-10-13T10:00:00.000Z" } })) as typeof fetch;
  assert.deepEqual(await readArrSnapshot("/api/admin/queue", { parse }), { data: { rows: [1] }, at: "2026-10-13T10:00:00.000Z" });
  body = { rows: "nope" };
  assert.equal(await readArrSnapshot("/api/admin/queue", { parse }), null);
});
