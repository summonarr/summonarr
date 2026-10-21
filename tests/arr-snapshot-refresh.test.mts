// The admin arr pages' background re-reads (src/lib/arr-snapshot.ts,
// /api/cron/refresh-arr-snapshots, guardrail 5h): every view an admin opened in
// the last day is re-read through its route's own handler on its page's
// priority — 5 / 10 / 15 minutes — so the page opens on recent data.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import {
  SNAPSHOT_REFRESH_TIERS,
  SNAPSHOT_VIEW_WINDOW_MS,
  dueSnapshots,
  readSnapshot,
  refreshArrSnapshots,
  refreshEveryMs,
  resetArrSnapshotsForTests,
  routePathOf,
  snapshotKey,
  snapshotted,
} from "../src/lib/arr-snapshot.ts";

beforeEach(() => resetArrSnapshotsForTests());

const MIN = 60_000;

test("priorities: the queue and health every 5 minutes, Missing / history / calendar / titles every 10, Arr System every 15", () => {
  assert.equal(refreshEveryMs("/api/admin/queue"), 5 * MIN);
  assert.equal(refreshEveryMs("/api/admin/arr-health"), 5 * MIN);
  for (const p of ["/api/admin/missing", "/api/admin/arr/history", "/api/admin/arr/blocklist", "/api/admin/arr/calendar", "/api/admin/arr/title", "/api/admin/arr/title/files"]) {
    assert.equal(refreshEveryMs(p), 10 * MIN, p);
  }
  for (const p of ["/api/admin/arr/tasks", "/api/admin/arr/providers", "/api/admin/arr/storage"]) assert.equal(refreshEveryMs(p), 15 * MIN, p);
  assert.equal(refreshEveryMs("/api/admin/arr/title/releases"), null, "a release search is never re-run");
  assert.equal(refreshEveryMs("/base/api/admin/queue"), 5 * MIN, "below a basePath");
  assert.equal(routePathOf("/base/api/admin/queue"), "/api/admin/queue");
});

test("every route wrapped with snapshotted has a refresh priority — a new arr page is refreshed too", () => {
  const routes = [
    "queue", "arr-health", "missing", "missing/episodes", "arr/history", "arr/blocklist", "arr/calendar",
    "arr/tasks", "arr/providers", "arr/storage", "arr/title", "arr/title/episodes", "arr/title/files", "arr/title/history",
  ];
  for (const r of routes) {
    const src = readFileSync(new URL(`../src/app/api/admin/${r}/route.ts`, import.meta.url), "utf8");
    assert.match(src, /withAdmin\(snapshotted\(/, `${r} is wrapped`);
    assert.notEqual(refreshEveryMs(`/api/admin/${r}`), null, `${r} has a tier`);
  }
  const listed = SNAPSHOT_REFRESH_TIERS.flatMap((t) => t.paths);
  assert.equal(listed.length, routes.length, "and nothing else is");
});

// A handler that answers what the test says, recording what each call saw.
function fakeRoute(answer: (req: NextRequest) => Response | Promise<Response>) {
  const calls: Array<{ url: string; lang: string | null; session: unknown }> = [];
  const GET = snapshotted(async (req: NextRequest, _ctx: unknown, session: unknown) => {
    calls.push({ url: req.url, lang: req.headers.get("accept-language"), session });
    return answer(req);
  });
  return { GET, calls };
}

const at = (url: string, lang = "en") => new NextRequest(url, { headers: { "accept-language": lang } });

async function openAt(GET: ReturnType<typeof fakeRoute>["GET"], url: string, whenMs: number, lang = "en") {
  const real = Date.now;
  Date.now = () => whenMs;
  try {
    await GET(at(url, lang), {}, { user: { id: "admin-1" } });
  } finally {
    Date.now = real;
  }
}

test("due: a view is re-read once its priority's interval (less a minute's slack) has passed — never sooner, and only views an admin opened in the last day", async () => {
  const t0 = 1_000_000_000_000;
  const queue = fakeRoute(() => Response.json({ items: [] }));
  const tasks = fakeRoute(() => Response.json({ tasks: [] }));
  await openAt(queue.GET, "http://x/api/admin/queue", t0);
  await openAt(tasks.GET, "http://x/api/admin/arr/tasks", t0);

  assert.deepEqual(dueSnapshots(t0 + 3 * MIN), [], "nothing is due 3 minutes in");
  assert.deepEqual(dueSnapshots(t0 + 4 * MIN).map((d) => new URL(d.url).pathname), ["/api/admin/queue"], "the 5-minute tier, with the minute's slack");
  assert.deepEqual(dueSnapshots(t0 + 14 * MIN).map((d) => new URL(d.url).pathname), ["/api/admin/queue", "/api/admin/arr/tasks"], "high priority first");

  assert.equal(dueSnapshots(t0 + SNAPSHOT_VIEW_WINDOW_MS + 1).length, 0, "a view nobody opened for a day is left alone");
  // The answers themselves are past their max age by then; open it again and it counts again.
  await openAt(queue.GET, "http://x/api/admin/queue", t0 + SNAPSHOT_VIEW_WINDOW_MS);
  assert.equal(dueSnapshots(t0 + SNAPSHOT_VIEW_WINDOW_MS + 5 * MIN).length, 1);
});

test("a cached open is a view too; a background re-read is NOT — a page nobody opens stops being refreshed", async () => {
  let real = Date.now;
  const t0 = 1_000_000_000_000;
  const queue = fakeRoute(() => Response.json({ n: 1 }));
  await openAt(queue.GET, "http://x/api/admin/queue", t0);

  // Re-read in the background every 5 minutes for a whole day…
  let now = t0;
  for (let i = 0; i < 300 && now < t0 + SNAPSHOT_VIEW_WINDOW_MS + 10 * MIN; i++) {
    now += 5 * MIN;
    await refreshArrSnapshots({ now: () => now });
  }
  assert.equal(dueSnapshots(now + 5 * MIN).length, 0, "background re-reads never kept the view alive");

  // …whereas an admin's cached open does.
  resetArrSnapshotsForTests();
  await openAt(queue.GET, "http://x/api/admin/queue", t0);
  real = Date.now;
  Date.now = () => t0 + 20 * 60 * MIN;
  try {
    assert.equal((await queue.GET(at("http://x/api/admin/queue?cached=1"), {}, {})).status, 200);
  } finally {
    Date.now = real;
  }
  assert.equal(dueSnapshots(t0 + 20 * 60 * MIN + SNAPSHOT_VIEW_WINDOW_MS - MIN).length, 1, "the cached open counted as a view");
});

test("a re-read runs the route's own handler, as the system, in the view's language, and keeps exactly what it answers", async () => {
  const t0 = 1_000_000_000_000;
  let n = 0;
  const route = fakeRoute((req) => Response.json({ n: ++n, lang: req.headers.get("accept-language") }));
  await openAt(route.GET, "http://x/api/admin/arr/history?service=sonarr&instance=4k&page=2", t0, "fr");

  const result = await refreshArrSnapshots({ now: () => t0 + 11 * MIN });
  assert.deepEqual(result, { due: 1, refreshed: 1, failed: 0, deferred: 0, aborted: false });
  const last = route.calls.at(-1)!;
  assert.equal(last.url, "http://x/api/admin/arr/history?service=sonarr&instance=4k&page=2", "the same read, without `cached`");
  assert.equal(last.lang, "fr");
  assert.equal((last.session as { user: { id: string } }).user.id, "system:arr-snapshot-refresh");
  const key = snapshotKey("http://x/api/admin/arr/history?service=sonarr&instance=4k&page=2", "fr")!;
  const kept = readSnapshot(key, t0 + 12 * MIN)!;
  assert.deepEqual(JSON.parse(kept.body), { n: 2, lang: "fr" });
  assert.equal(kept.at, t0 + 11 * MIN, "stamped with when the re-read landed");
});

test("a failed re-read keeps the last good answer; a throw is counted, not raised", async () => {
  const t0 = 1_000_000_000_000;
  let mode: "ok" | "502" | "throw" = "ok";
  const route = fakeRoute(() => {
    if (mode === "throw") throw new Error("boom");
    return mode === "ok" ? Response.json({ good: true }) : Response.json({ error: "Sonarr didn't answer" }, { status: 502 });
  });
  await openAt(route.GET, "http://x/api/admin/missing?service=sonarr", t0);
  mode = "502";
  assert.deepEqual(await refreshArrSnapshots({ now: () => t0 + 11 * MIN }), { due: 1, refreshed: 0, failed: 1, deferred: 0, aborted: false });
  mode = "throw";
  assert.equal((await refreshArrSnapshots({ now: () => t0 + 22 * MIN })).failed, 1);
  const key = snapshotKey("http://x/api/admin/missing?service=sonarr", "en")!;
  assert.deepEqual(JSON.parse(readSnapshot(key, t0 + 23 * MIN)!.body), { good: true });
});

test("bounded: at most maxPerRun re-reads, 2 at a time; a stopped run starts nothing new (guardrail 41)", async () => {
  const t0 = 1_000_000_000_000;
  let inFlight = 0;
  let peak = 0;
  const route = fakeRoute(async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return Response.json({});
  });
  for (let i = 1; i <= 6; i++) await openAt(route.GET, `http://x/api/admin/arr/history?page=${i}`, t0);
  const before = route.calls.length;
  const result = await refreshArrSnapshots({ now: () => t0 + 11 * MIN, maxPerRun: 4 });
  assert.deepEqual(result, { due: 6, refreshed: 4, failed: 0, deferred: 2, aborted: false });
  assert.equal(route.calls.length - before, 4);
  assert.equal(peak, 2, "two at a time");

  const ctl = new AbortController();
  ctl.abort();
  const stopped = await refreshArrSnapshots({ now: () => t0 + 11 * MIN, signal: ctl.signal });
  assert.equal(stopped.aborted, true);
  assert.equal(stopped.refreshed, 0);
  assert.equal(route.calls.length - before, 4, "nothing started after the abort");
});

test("a config write that clears the snapshots while a re-read is out wins: the answer is not put back", async () => {
  const t0 = 1_000_000_000_000;
  let release: () => void = () => {};
  let hold = false;
  const route = fakeRoute(async () => {
    if (hold) await new Promise<void>((r) => { release = r; });
    return Response.json({ instance: "removed" });
  });
  await openAt(route.GET, "http://x/api/admin/arr/storage", t0);
  hold = true;
  const run = refreshArrSnapshots({ now: () => t0 + 16 * MIN });
  await new Promise((r) => setTimeout(r, 5));
  const { clearArrSnapshots } = await import("../src/lib/arr-snapshot.ts");
  clearArrSnapshots();
  release();
  await run;
  assert.equal(readSnapshot(snapshotKey("http://x/api/admin/arr/storage", "en")!, t0 + 17 * MIN), null);
});

test("the cron route skips without a lock when nothing is due, and is wired into the container's cron loop and the System tab", () => {
  const route = readFileSync(new URL("../src/app/api/cron/refresh-arr-snapshots/route.ts", import.meta.url), "utf8");
  assert.match(route, /if \(dueSnapshots\(\)\.length === 0\) return cronSkippedResponse\(/);
  assert.match(route, /withCronRunRecording\("arr-snapshots", \(\) => withAdvisoryLock\(\s*ARR_SNAPSHOT_LOCK_ID,/);
  assert.match(route, /refreshArrSnapshots\(\{ signal \}\)/);
  const entry = readFileSync(new URL("../docker-entrypoint.sh", import.meta.url), "utf8");
  assert.match(entry, /\/api\/cron\/refresh-arr-snapshots\}" "arr-snapshots" quiet/);
  assert.match(entry, /ARR_SNAPSHOT_NEXT=\$\(_cron_next "\$rc" "\$NOW" "\$\{ARR_SNAPSHOT_INTERVAL:-300\}" 300\)/);
  const settings = readFileSync(new URL("../src/app/(app)/settings/page.tsx", import.meta.url), "utf8");
  assert.match(settings, /endpoint: "\/api\/cron\/refresh-arr-snapshots", interval: formatInterval\(t, process\.env\.ARR_SNAPSHOT_INTERVAL, "300"\), \.\.\.lastRunInfo\("arr-snapshots"\)/);
});
