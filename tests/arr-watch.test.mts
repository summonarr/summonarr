// The Radarr/Sonarr monitor (src/lib/arr-watch.ts pure rules, arr-watch-data.ts
// run, POST /api/cron/arr-watch) and the four outbound events it adds to the
// notification catalog.
//
// What is pinned, and why each one matters:
//   1. A LOW DISK IS A CONDITION (guardrail 7b): announced on a change of state
//      per (instance, disk) only — never every run while it stays low — with a
//      recovery margin so a disk hovering at the line can't flap. Only disks
//      holding a root folder are judged (the container root filling is not a
//      media alert); two root folders on one disk are one alert.
//   2. A FAILED DOWNLOAD IS AN EVENT: each new one is sent once, never held back
//      because a similar one was sent. "New" is a cursor over the arr's own
//      history (date, then id); a Sonarr pack's per-episode records fold into
//      ONE event by downloadId — including records that land in the next run.
//      A backlog past the per-run cap is DEFERRED to the next run, never dropped.
//      A first run seeds the cursor and announces no history.
//   3. A DOWNLOAD NEWLY NEEDING ATTENTION is announced once: it is remembered
//      for 24 h after it was last seen stuck, so one that drops off the queue
//      for a read (an arr restart, a dark download client, paging) and comes
//      back is NOT news; at most 25 per instance per run, the rest announced
//      by the next run, never dropped. A first run seeds silently. A disk that
//      drops out of a read (a flapping mount) keeps its state the same 24 h.
//   3a. A root folder on a mount /diskspace doesn't list is NOT judged against
//      "/" (which holds every path): the disk match needs the free space to
//      agree, otherwise the root folder is its own reading, size unknown.
//   4. STATE FIRST, EVENTS SECOND: a failed state write sends nothing (the next
//      run finds the same events), and a run the lock's AbortSignal stopped
//      writes nothing and sends nothing (guardrail 41).
//   5. Nothing an alert carries is a download path, a release URL or a
//      credential (the arr's message is masked); the instance is named.
//   6. The cron route: skipped BEFORE its lock when nothing is watchable,
//      degraded (200 + X-Cron-Degraded) when an instance can't be read.
//   7. The nav badge reads one row and fails open; a stale snapshot shows none.
//
// Harness: in-memory prisma (setting, notificationAgent), Radarr/Sonarr and
// one webhook channel scripted on RFC1918 literals (admin SSRF mode, no DNS),
// and the pg Client.prototype seam for the advisory lock. No DB, no network.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";
import { Client } from "pg";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "arr-watch-test-secret-0123456789abcdef";
process.env.AUTH_URL = "https://summon.example";
process.env.TRUST_PROXY = "true";
process.env.DATABASE_URL = "postgres://u:p@127.0.0.1:5432/db"; // Client.prototype is stubbed; never dialed
const CRON_SECRET = "arr-watch-cron-secret-0123456789abcdef";
process.env.CRON_SECRET = CRON_SECRET;
delete process.env.BASE_PATH;
delete process.env.SUMMONARR_DEFAULT_LOCALE;
delete process.env.ARR_WATCH_INTERVAL;
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

const fakeLookup = async () => [{ address: "10.0.0.250", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) throw new Error("could not stub dns.lookup");

const warns: string[] = [];
console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(" ")); };
console.error = () => {};

// ── pg (advisory lock) ───────────────────────────────────────────────────────
let lockCalls: Array<{ op: string; id: number }> = [];
const pgProto = Client.prototype as unknown as {
  connect: () => Promise<void>;
  query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }>;
  end: () => Promise<void>;
};
pgProto.connect = async () => {};
pgProto.query = async (text, values) => {
  if (text.includes("pg_try_advisory_lock")) {
    lockCalls.push({ op: "try", id: Number(values?.[0]) });
    return { rows: [{ acquired: true }] };
  }
  if (text.includes("pg_advisory_unlock")) lockCalls.push({ op: "unlock", id: Number(values?.[0]) });
  return { rows: [] };
};
pgProto.end = async () => {};

// ── scripted Radarr / Sonarr / webhook channel ───────────────────────────────
const RADARR = "http://10.0.0.5:7878";
const SONARR = "http://10.0.0.7:8989";
const HOOK = "http://10.88.0.5:8080/hook";

interface ArrFixture {
  rootfolder: unknown[];
  diskspace: unknown[];
  history: Array<Record<string, unknown>>;
  queue: unknown[];
  /** Paths (pathname) answered 503. */
  down: Set<string>;
  /** Answer /history/since with 404 (an arr without the endpoint). */
  noSince: boolean;
  /** The queue's reported totalRecords (default: the records' length) — more than a page makes the reader page on. */
  queueTotal?: number;
  /** Runs as each queue page is served. */
  onQueuePage?: (page: number) => void;
  /** This queue page never answers — it waits for the request's signal to abort. */
  queueHangPage?: number;
}
const fixtures = new Map<string, ArrFixture>();
function fixture(origin: string): ArrFixture {
  const f: ArrFixture = { rootfolder: [], diskspace: [], history: [], queue: [], down: new Set(), noSince: false };
  fixtures.set(origin, f);
  return f;
}
type Call = { origin: string; path: string; query: URLSearchParams; body: string };
let calls: Call[] = [];
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  calls.push({ origin: url.origin, path: url.pathname, query: url.searchParams, body: String(init?.body ?? "") });
  if (url.href === HOOK) return new Response("ok", { status: 200 });
  const f = fixtures.get(url.origin);
  if (!f) throw new Error(`unexpected fetch ${url.href}`);
  if (f.down.has(url.pathname)) return json({ message: "down" }, 503);
  switch (url.pathname) {
    case "/api/v3/rootfolder": return json(f.rootfolder);
    case "/api/v3/diskspace": return json(f.diskspace);
    case "/api/v3/history/since": {
      if (f.noSince) return json({ message: "not found" }, 404);
      const since = Date.parse(url.searchParams.get("date") ?? "");
      return json(f.history.filter((r) => Date.parse(String(r.date)) >= since));
    }
    case "/api/v3/history": {
      const sorted = [...f.history].sort((a, b) => Date.parse(String(b.date)) - Date.parse(String(a.date)));
      return json({ page: 1, pageSize: 200, totalRecords: sorted.length, records: sorted });
    }
    case "/api/v3/queue": {
      const page = Number(url.searchParams.get("page") ?? "1");
      f.onQueuePage?.(page);
      if (f.queueHangPage === page) {
        const signal = init?.signal;
        return new Promise<Response>((_, reject) => {
          signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        });
      }
      return json({ page, pageSize: 250, totalRecords: f.queueTotal ?? f.queue.length, records: f.queue });
    }
  }
  throw new Error(`unscripted ${url.pathname}`);
}) as typeof fetch;

// ── prisma ───────────────────────────────────────────────────────────────────
const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel, shadowPrismaClientMethod } = await import("./_helpers.mts");
const settings = new Map<string, string>();
let failStateWrite = false;
let settingWrites: string[] = [];
shadowPrismaModel(prisma, "setting", {
  findUnique: async (args: { where: { key: string } }) => {
    const v = settings.get(args.where.key);
    return v === undefined ? null : { key: args.where.key, value: v };
  },
  findMany: async (args: { where?: { key?: { in?: string[] } } } = {}) => {
    const keys = args.where?.key?.in;
    return [...settings.entries()].filter(([k]) => !keys || keys.includes(k)).map(([key, value]) => ({ key, value }));
  },
  upsert: async (args: { where: { key: string }; create: { value: string }; update: { value: string } }) => {
    if (failStateWrite && args.where.key === "arrWatch:state") throw new Error("db down");
    settingWrites.push(args.where.key);
    settings.set(args.where.key, args.update.value);
    return { key: args.where.key, value: args.update.value };
  },
});
shadowPrismaClientMethod(prisma, "$transaction", async (arg: unknown) =>
  Array.isArray(arg) ? Promise.all(arg) : (arg as (tx: unknown) => Promise<unknown>)(prisma),
);
const AGENT = {
  id: "a1", kind: "webhook", name: "hook", enabled: true,
  events: ["arr.disk_low", "arr.disk_ok", "arr.download_failed", "arr.queue_attention"],
  config: { url: HOOK }, secret: null,
};
shadowPrismaModel(prisma, "notificationAgent", {
  findMany: async () => [AGENT],
  update: async () => ({ id: "a1" }),
});

const W = await import("../src/lib/arr-watch.ts");
const { runArrWatch, readArrWatchNavBadges, ARR_WATCH_STATE_KEY, ARR_WATCH_SUMMARY_KEY } = await import("../src/lib/arr-watch-data.ts");
const { invalidateFeatureFlagCache } = await import("../src/lib/features.ts");
const { invalidateAgentCache } = await import("../src/lib/notify-agents.ts");
const { resetLogDedup } = await import("../src/lib/log-dedup.ts");
const { buildWebhookPayload, eventLink, NOTIFY_EVENT_KEYS } = await import("../src/lib/notify-events.ts");
const { renderAgentText } = await import("../src/lib/notify-agents.ts");
const { ARR_WATCH_LOCK_ID } = await import("../src/lib/advisory-lock.ts");
const { NextRequest } = await import("next/server");
const { POST: cronPost } = await import("../src/app/api/cron/arr-watch/route.ts");

async function settle(rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
}
type Delivery = { event: string; title: string; message: string; url: string | null; media: { tmdbId: number | null; title: string } | null; text: string | null; arr: Record<string, unknown> | null };
const deliveries = (): Delivery[] => calls.filter((c) => c.origin === new URL(HOOK).origin).map((c) => JSON.parse(c.body) as Delivery);
const arrCalls = (origin: string, path?: string) => calls.filter((c) => c.origin === origin && (!path || c.path === path));

const GB = 1000 ** 3;
const T0 = Date.parse("2026-10-11T12:00:00.000Z");
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

function radarrDisk(f: ArrFixture, freeGb: number, totalGb = 1000) {
  f.rootfolder = [{ id: 1, path: "/movies", accessible: true, freeSpace: freeGb * GB }];
  // The container root is nearly full — it holds no root folder, so it is never judged.
  f.diskspace = [
    { path: "/", label: "overlay", freeSpace: 1 * GB, totalSpace: 50 * GB },
    { path: "/movies", label: "media", freeSpace: freeGb * GB, totalSpace: totalGb * GB },
  ];
}

function radarrFailure(id: number, ms: number, extra: Record<string, unknown> = {}) {
  return {
    id, movieId: 7, sourceTitle: `Arrival.2016.1080p.${id}`, date: iso(ms), downloadId: `nzo_${id}`, eventType: "downloadFailed",
    data: { message: "Unpack failed in /downloads/incomplete/Arrival see https://indexer.example/api?apikey=SECRET123&t=get", downloadClient: "SAB" },
    movie: { tmdbId: 329865, title: "Arrival", year: 2016 },
    ...extra,
  };
}

function queueRecord(id: number, downloadId: string, attention: boolean) {
  return {
    id, downloadId, title: `Dune.2021.2160p.${downloadId}`, movieId: 5, movie: { tmdbId: 438631, title: "Dune", year: 2021 },
    status: "completed", trackedDownloadStatus: attention ? "warning" : "ok", trackedDownloadState: attention ? "importBlocked" : "importPending",
    statusMessages: attention ? [{ title: "Dune", messages: ["No files found are eligible for import in /downloads/complete/Dune.2021"] }] : [],
    size: 100, sizeleft: 0, protocol: "torrent",
  };
}

beforeEach(() => {
  settings.clear();
  fixtures.clear();
  calls = [];
  lockCalls = [];
  warns.length = 0;
  settingWrites = [];
  failStateWrite = false;
  invalidateFeatureFlagCache();
  invalidateAgentCache();
  resetLogDedup();
});

function configureRadarr(): ArrFixture {
  settings.set("radarrUrl", RADARR);
  settings.set("radarrApiKey", "radarr-key");
  settings.set("feature.integration.sonarr", "false");
  const f = fixture(RADARR);
  radarrDisk(f, 500);
  return f;
}

// ── settings ─────────────────────────────────────────────────────────────────

test("the disk threshold: whole percent 1–50 on write; anything else reads as the default 10", () => {
  assert.equal(W.validateDiskLowPercent("15"), 15);
  assert.equal(W.validateDiskLowPercent(1), 1);
  assert.equal(W.validateDiskLowPercent(50), 50);
  for (const bad of ["0", "51", "7.5", "1e1", "", " ", "abc", -3, 12.5, null, undefined, {}]) {
    assert.equal(W.validateDiskLowPercent(bad), null, String(bad));
  }
  assert.equal(W.parseDiskLowPercent("20"), 20);
  assert.equal(W.parseDiskLowPercent("90"), W.DEFAULT_DISK_LOW_PERCENT);
  assert.equal(W.parseDiskLowPercent(undefined), 10);
});

// ── 1: disks ─────────────────────────────────────────────────────────────────

const ROOT = (path: string, free: number | null, accessible = true) =>
  ({ id: 1, path, accessible, freeSpace: free, totalSpace: null, unmappedFolders: [], unmappedCount: 0 });
const DISK = (path: string, free: number, total: number) => ({ path, label: null, freeSpace: free, totalSpace: total });

test("only disks holding a root folder are judged; two root folders on one disk are ONE reading", () => {
  const readings = W.readDisks(
    [ROOT("/data/movies", 40 * GB), ROOT("/data/movies-4k", 40 * GB), ROOT("/offline", null, false)],
    [DISK("/", 1 * GB, 50 * GB), DISK("/data", 40 * GB, 1000 * GB)],
  );
  assert.deepEqual(readings.map((r) => [r.path, r.roots, r.freePercent]), [["/data", ["/data/movies", "/data/movies-4k"], 4]]);
});

test("a root folder on a mount /diskspace doesn't list is not filed under \"/\" — its own reading, keyed by its path, floor rule only", () => {
  // projectRootFolders copied "/"'s size onto the root folder (diskFor matched it) — that copy must not be used either.
  const pool = { ...ROOT("/mnt/user/media", 20_000 * GB), totalSpace: 100 * GB };
  const small = { ...ROOT("/mnt/rclone/tv", 8 * GB), totalSpace: 100 * GB };
  const readings = W.readDisks([pool, small], [DISK("/", 60 * GB, 100 * GB)]);
  assert.deepEqual(readings.map((r) => [r.path, r.totalBytes, r.freePercent]), [["/mnt/rclone/tv", null, null], ["/mnt/user/media", null, null]]);
  assert.equal(W.isDiskLow(readings[1], 10), false, "20 TB free is not low, whatever \"/\" holds");
  assert.equal(W.isDiskLow(readings[0], 10), true, "under the 10 GB floor");
  // Free space that agrees (within 1 GB / 1%) keeps the match.
  assert.deepEqual(W.readDisks([ROOT("/data/movies", 40.5 * GB)], [DISK("/data", 40 * GB, 1000 * GB)]).map((r) => r.path), ["/data"]);
  assert.deepEqual(W.readDisks([ROOT("/data/movies", 42 * GB)], [DISK("/data", 40 * GB, 1000 * GB)]).map((r) => r.path), ["/data/movies"]);
  assert.equal(W.rootDisk(ROOT("/data/x", null), [DISK("/data", 40 * GB, 1000 * GB)])?.path, "/data", "no free space to compare: the match stands");
});

test("nothing to compare never makes the catch-all \"/\" believable — no reading keyed \"/\" with \"/\"'s numbers", () => {
  // Audit fix C103: an accessible root folder with no free space (a slow statfs
  // on a network mount) was matched to "/" unchecked and judged as the container root.
  const root = DISK("/", 5 * GB, 100 * GB);
  assert.equal(W.rootDisk(ROOT("/mnt/share/movies", null), [root]), null);
  assert.equal(W.rootDisk(ROOT("/mnt/share/movies", null), [root, DISK("/config", 1 * GB, 10 * GB)]), null);
  assert.deepEqual(W.readDisks([ROOT("/mnt/share/movies", null)], [root]), [], "no free space of its own: skipped, not judged on \"/\"'s");
  // "/" reporting no free space: the folder's own reading, on the floor rule alone.
  const blind = { path: "/", label: null, freeSpace: null, totalSpace: 100 * GB };
  assert.equal(W.rootDisk(ROOT("/mnt/share/movies", 8 * GB), [blind]), null);
  assert.deepEqual(W.readDisks([ROOT("/mnt/share/movies", 8 * GB)], [blind]).map((r) => [r.path, r.totalBytes]), [["/mnt/share/movies", null]]);
  // A folder that IS "/" (either separator, trailing ones trimmed) still sits on it; a nearer disk keeps its match.
  assert.equal(W.rootDisk(ROOT("/", null), [root])?.path, "/");
  assert.equal(W.rootDisk(ROOT("/mnt/share/movies", null), [root, DISK("/mnt/share", 30 * GB, 900 * GB)])?.path, "/mnt/share");
});

test("a root folder no disk holds is judged on the absolute floor alone", () => {
  const [r] = W.readDisks([ROOT("//nas/movies", 8 * GB)], []);
  assert.equal(r.totalBytes, null);
  assert.equal(r.freePercent, null);
  assert.equal(W.isDiskLow(r, 10), true, "under 10 GB with no size known is low");
  assert.equal(W.isDiskLow({ ...r, freeBytes: 500 * GB }, 10), false);
});

test("a disk is announced when it CROSSES the line, never again while it stays low", () => {
  const at = (pct: number) => W.readDisks([ROOT("/m", pct * 10 * GB)], [DISK("/m", pct * 10 * GB, 1000 * GB)]);
  const first = W.judgeDisks(at(5), 10, null);
  assert.deepEqual(first.transitions.map((t) => t.to), ["low"], "a disk already low on the first run is news");
  const again = W.judgeDisks(at(4), 10, first.next);
  assert.deepEqual(again.transitions, [], "a disk that STAYS low must not re-announce every run (guardrail 7b)");
  assert.deepEqual(again.next, { "/m": "low" });
  assert.deepEqual(W.judgeDisks(at(50), 10, null).transitions, [], "a healthy disk on the first run is not news");
});

test("a low disk hovering at the line does not flap: ok again only 2 points clear of it", () => {
  const at = (pct: number) => W.readDisks([ROOT("/m", pct * 10 * GB)], [DISK("/m", pct * 10 * GB, 1000 * GB)]);
  let state = W.judgeDisks(at(9.5), 10, null).next;
  for (const pct of [10.5, 11.9, 9.9, 11.5]) {
    const j = W.judgeDisks(at(pct), 10, state);
    assert.deepEqual(j.transitions, [], `${pct}% flapped`);
    state = j.next;
  }
  const back = W.judgeDisks(at(12), 10, state);
  assert.deepEqual(back.transitions.map((t) => t.to), ["ok"]);
  assert.deepEqual(back.next, { "/m": "ok" });
});

test("a low disk that drops out of a read (inaccessible root folder) and comes back still low is not announced again; past 24 h it is", () => {
  const at = (pct: number) => W.readDisks([ROOT("/m", pct * 10 * GB)], [DISK("/m", pct * 10 * GB, 1000 * GB)]);
  const first = W.judgeDisks(at(5), 10, null, { gone: null, nowMs: T0 });
  assert.equal(first.transitions.length, 1);
  const dark = W.judgeDisks([], 10, first.next, { gone: first.gone, nowMs: T0 + 15 * MIN });
  assert.deepEqual(dark.next, {}, "the summary counts disks read now");
  assert.deepEqual(dark.gone, { "/m": { state: "low", at: iso(T0 + 15 * MIN) } });
  const back = W.judgeDisks(at(5), 10, dark.next, { gone: dark.gone, nowMs: T0 + 30 * MIN });
  assert.deepEqual(back.transitions, [], "the same low disk re-announced");
  assert.deepEqual(back.gone, {}, "back, so no longer remembered as gone");
  // Recovered while it was gone: that IS a change.
  assert.deepEqual(W.judgeDisks(at(50), 10, dark.next, { gone: dark.gone, nowMs: T0 + 30 * MIN }).transitions.map((t) => t.to), ["ok"]);
  // Gone longer than the grace: forgotten, and a low disk is news again.
  const stillDark = W.judgeDisks([], 10, dark.next, { gone: dark.gone, nowMs: T0 + 25 * 60 * MIN });
  assert.deepEqual(stillDark.gone, {});
  assert.equal(W.judgeDisks(at(5), 10, stillDark.next, { gone: stillDark.gone, nowMs: T0 + 25 * 60 * MIN }).transitions.length, 1);
  // An expired entry handed back as is (a run that read nothing in between) is not recalled either.
  assert.equal(W.judgeDisks(at(5), 10, {}, { gone: dark.gone, nowMs: T0 + 25 * 60 * MIN }).transitions.length, 1);
});

test("the 10 GB floor makes a small disk low whatever its percentage", () => {
  const [r] = W.readDisks([ROOT("/m", 9 * GB)], [DISK("/m", 9 * GB, 50 * GB)]);
  assert.equal(r.freePercent, 18);
  assert.equal(W.isDiskLow(r, 10), true);
});

// ── 2: failed downloads ──────────────────────────────────────────────────────

const H = (id: number, ms: number, over: Partial<Record<string, unknown>> = {}) => ({
  id, service: "sonarr", instance: "", kind: "failed", date: iso(ms), sourceTitle: `Show.S01.${over.downloadId ?? id}`,
  arrMediaId: 3, mediaTitle: "Show", year: 2020, tmdbId: 1399, tvdbId: 121361, episode: null, episodeId: null,
  quality: null, qualityTags: [], languages: [], customFormats: [], customFormatScore: null, downloadId: `dl${id}`,
  indexer: null, downloadClient: null, releaseGroup: null, protocol: "usenet", size: null, reason: null,
  message: "Download failed", droppedPath: null, importedPath: null, sourcePath: null, path: null, ...over,
}) as Parameters<typeof W.selectNewFailures>[0][number];

test("a first run seeds the cursor at now and reads no history; a stale cursor resumes a day back", () => {
  assert.deepEqual(W.effectiveCursor(null, T0), { cursor: { at: iso(T0), lastId: 0 }, seeded: true });
  const stale = W.effectiveCursor({ at: iso(T0 - 5 * 24 * 60 * MIN), lastId: 900 }, T0);
  assert.deepEqual(stale, { cursor: { at: iso(T0 - 24 * 60 * MIN), lastId: 0 }, seeded: false });
  const fresh = { at: iso(T0 - 10 * MIN), lastId: 4 };
  assert.deepEqual(W.effectiveCursor(fresh, T0), { cursor: fresh, seeded: false });
});

test("only records PAST the cursor are new — by date, then id at the same instant", () => {
  const cursor = { at: iso(T0), lastId: 10 };
  const out = W.selectNewFailures([H(9, T0 - MIN), H(10, T0), H(11, T0), H(12, T0 + MIN)], cursor, []);
  assert.deepEqual(out.groups.map((g) => g.downloadId), ["dl11", "dl12"]);
  assert.deepEqual(out.cursor, { at: iso(T0 + MIN), lastId: 12 });
  // The same records read again from the new cursor: nothing new.
  assert.deepEqual(W.selectNewFailures([H(11, T0), H(12, T0 + MIN)], out.cursor, out.recent).groups, []);
});

test("a Sonarr pack's per-episode records are ONE failed download, counting its episodes", () => {
  const ep = (id: number, n: number) => H(id, T0 + MIN, { downloadId: "PACK", episode: { seasonNumber: 1, episodeNumber: n, title: "" } });
  const out = W.selectNewFailures([ep(21, 1), ep(22, 2), ep(23, 3)], { at: iso(T0), lastId: 0 }, []);
  assert.equal(out.groups.length, 1);
  assert.equal(out.groups[0].episodes, 3);
  assert.equal(out.groups[0].downloadId, "PACK");
});

test("a pack split across two runs is still one announcement — its late records fold into the first", () => {
  const ep = (id: number, n: number, ms: number) => H(id, ms, { downloadId: "PACK", episode: { seasonNumber: 1, episodeNumber: n, title: "" } });
  const first = W.selectNewFailures([ep(21, 1, T0 + MIN)], { at: iso(T0), lastId: 0 }, []);
  assert.equal(first.groups.length, 1);
  const second = W.selectNewFailures([ep(22, 2, T0 + MIN + 50), ep(23, 3, T0 + MIN + 90)], first.cursor, first.recent);
  assert.deepEqual(second.groups, [], "the rest of the pack re-announced the download");
  assert.deepEqual(second.cursor, { at: iso(T0 + MIN + 90), lastId: 23 }, "the folded records are still consumed");
  // The same download id failing again much later is a NEW failure (an event, never repeat-suppressed).
  const later = W.selectNewFailures([ep(40, 1, T0 + 5 * 60 * MIN)], second.cursor, second.recent);
  assert.equal(later.groups.length, 1);
});

test("a backlog past the per-run cap is DEFERRED to the next run, never dropped", () => {
  const records = Array.from({ length: 5 }, (_, i) => H(100 + i, T0 + (i + 1) * MIN));
  const first = W.selectNewFailures(records, { at: iso(T0), lastId: 0 }, [], 2);
  assert.deepEqual(first.groups.map((g) => g.downloadId), ["dl100", "dl101"]);
  assert.equal(first.deferred, 3);
  const second = W.selectNewFailures(records, first.cursor, first.recent, 2);
  assert.deepEqual(second.groups.map((g) => g.downloadId), ["dl102", "dl103"]);
  const third = W.selectNewFailures(records, second.cursor, second.recent, 2);
  assert.deepEqual(third.groups.map((g) => g.downloadId), ["dl104"]);
  assert.equal(third.deferred, 0);
});

test("the cap BREAKS: a later record of an announced download can't carry the cursor past a download that didn't fit", () => {
  // dl3 is over the cap; the dl1 record after it would fold into the announced
  // dl1 — consuming it (a `continue` past dl3) moved the cursor past dl3 for good.
  const records = [H(1, T0 + MIN), H(2, T0 + 2 * MIN), H(3, T0 + 3 * MIN), H(4, T0 + 4 * MIN, { downloadId: "dl1" })];
  const first = W.selectNewFailures(records, { at: iso(T0), lastId: 0 }, [], 2);
  assert.deepEqual(first.groups.map((g) => g.downloadId), ["dl1", "dl2"]);
  assert.deepEqual(first.cursor, { at: iso(T0 + 2 * MIN), lastId: 2 });
  assert.equal(first.deferred, 2);
  // The late dl1 record folds through `recent`; dl3 is announced, not lost.
  assert.deepEqual(W.selectNewFailures(records, first.cursor, first.recent, 2).groups.map((g) => g.downloadId), ["dl3"]);
});

test("in one run, a download's records fold only within the hour of its first — the same verdict as split across runs", () => {
  const one = W.selectNewFailures([H(10, T0 + MIN, { downloadId: "HASH" }), H(11, T0 + 5 * 60 * MIN, { downloadId: "HASH" })], { at: iso(T0), lastId: 0 }, []);
  assert.deepEqual(one.groups.map((g) => g.at), [iso(T0 + MIN), iso(T0 + 5 * 60 * MIN)], "a re-failure 5 h later was folded into the first (a catch-up run merged two events)");
  const a = W.selectNewFailures([H(10, T0 + MIN, { downloadId: "HASH" })], { at: iso(T0), lastId: 0 }, []);
  const b = W.selectNewFailures([H(11, T0 + 5 * 60 * MIN, { downloadId: "HASH" })], a.cursor, a.recent);
  assert.equal(a.groups.length + b.groups.length, one.groups.length);
  // Records written together still fold (the pack test above, inside the window).
  assert.equal(W.selectNewFailures([H(10, T0 + MIN, { downloadId: "HASH" }), H(11, T0 + 50 * MIN, { downloadId: "HASH" })], { at: iso(T0), lastId: 0 }, []).groups.length, 1);
});

test("a MANUAL mark (\"Manually marked as failed\") is consumed silently — an admin's action, not a failed download", () => {
  const manual = { message: "Manually marked as failed" };
  const mixed = W.selectNewFailures([H(5, T0 + MIN, manual), H(6, T0 + 2 * MIN)], { at: iso(T0), lastId: 0 }, []);
  assert.deepEqual(mixed.groups.map((g) => g.downloadId), ["dl6"]);
  assert.deepEqual(mixed.cursor, { at: iso(T0 + 2 * MIN), lastId: 6 });
  // Alone: nothing announced, but the cursor still passes it (never re-read).
  const only = W.selectNewFailures([H(7, T0 + 3 * MIN, manual)], mixed.cursor, mixed.recent);
  assert.deepEqual(only.groups, []);
  assert.deepEqual(only.cursor, { at: iso(T0 + 3 * MIN), lastId: 7 });
  assert.equal(only.deferred, 0);
  // A Sonarr pack marked by hand: one record per episode, no group.
  const ep = (id: number, n: number) => H(id, T0 + MIN, { downloadId: "PACK", message: " Manually marked as failed", episode: { seasonNumber: 1, episodeNumber: n, title: "" } });
  assert.deepEqual(W.selectNewFailures([ep(21, 1), ep(22, 2)], { at: iso(T0), lastId: 0 }, []).groups, []);
  // Before the cap: a burst of manual marks can't use up the budget.
  const burst = W.selectNewFailures([H(30, T0 + MIN, manual), H(31, T0 + 2 * MIN, manual), H(32, T0 + 3 * MIN)], { at: iso(T0), lastId: 0 }, [], 1);
  assert.deepEqual(burst.groups.map((g) => g.downloadId), ["dl32"]);
});

test("a record dated in the FUTURE is held back, not consumed — one bad arr clock can't blind the cursor", () => {
  const records = [H(1, T0 + 3 * 24 * 60 * MIN), H(2, T0 + 10 * MIN)];
  const now = T0 + 15 * MIN;
  const first = W.selectNewFailures(records, { at: iso(T0), lastId: 0 }, [], W.MAX_FAILURES_PER_RUN, now);
  assert.deepEqual(first.groups.map((g) => g.downloadId), ["dl2"], "a genuine failure was dropped behind a future cursor");
  assert.deepEqual(first.cursor, { at: iso(T0 + 10 * MIN), lastId: 2 });
  // Announced once the clock reaches it — delayed, never lost, never repeated.
  const later = T0 + 3 * 24 * 60 * MIN + MIN;
  const second = W.selectNewFailures(records, first.cursor, first.recent, W.MAX_FAILURES_PER_RUN, later);
  assert.deepEqual(second.groups.map((g) => g.downloadId), ["dl1"]);
  assert.deepEqual(W.selectNewFailures(records, second.cursor, second.recent, W.MAX_FAILURES_PER_RUN, later).groups, []);
  // Even a little ahead is held: any tolerance is a window of lost failures (below).
  const near = W.selectNewFailures([H(3, now + 30 * MIN)], { at: iso(T0), lastId: 0 }, [], W.MAX_FAILURES_PER_RUN, now);
  assert.deepEqual(near.groups, []);
  assert.deepEqual(near.cursor, { at: iso(T0), lastId: 0 });
});

test("a TRANSIENT arr clock jump loses nothing: the cursor never passes Summonarr's clock, so failures written after the correction are announced", () => {
  const HOUR = 60 * MIN;
  const jumped = H(1, T0 + 5 * HOUR); // written while the arr host's clock ran 5 h ahead, then corrected
  let state = { cursor: { at: iso(T0), lastId: 0 }, recent: [] as ReturnType<typeof W.selectNewFailures>["recent"] };
  const run = (records: ReturnType<typeof H>[], now: number) => {
    const out = W.selectNewFailures(records, state.cursor, state.recent, W.MAX_FAILURES_PER_RUN, now);
    assert.ok(Date.parse(out.cursor.at) <= now, `the cursor ${out.cursor.at} passed the run's clock ${iso(now)}`);
    state = { cursor: out.cursor, recent: out.recent };
    return out.groups.map((g) => g.downloadId);
  };
  assert.deepEqual(run([jumped], T0 + 15 * MIN), []);
  // 4 h 30 later: with a one-hour tolerance the jumped record was consumed here and the cursor moved to T0+5h.
  assert.deepEqual(run([jumped], T0 + 4.5 * HOUR), []);
  // A genuine failure the corrected arr writes 20 minutes later, dated before the jumped record.
  const genuine = H(2, T0 + 4.5 * HOUR + 20 * MIN);
  assert.deepEqual(run([jumped, genuine], T0 + 4.5 * HOUR + 25 * MIN), ["dl2"], "a genuine failure fell behind a cursor moved ahead by the jumped record");
  // The jumped record is announced once the clock reaches it — once.
  assert.deepEqual(run([jumped, genuine], T0 + 5 * HOUR), ["dl1"]);
  assert.deepEqual(run([jumped, genuine], T0 + 5 * HOUR + 15 * MIN), []);
});

test("a stored cursor far in the future restarts at NOW; one inside the tolerance is kept", () => {
  assert.deepEqual(W.effectiveCursor({ at: iso(T0 + 3 * 24 * 60 * MIN), lastId: 9 }, T0), { cursor: { at: iso(T0), lastId: 0 }, seeded: false });
  const near = { at: iso(T0 + 30 * MIN), lastId: 9 };
  assert.deepEqual(W.effectiveCursor(near, T0), { cursor: near, seeded: false });
});

test("only DownloadFailed records count — an arr that ignored the filter can't turn a grab into a failure", () => {
  const out = W.selectNewFailures([H(5, T0 + MIN, { kind: "grabbed" }), H(6, T0 + MIN)], { at: iso(T0), lastId: 0 }, []);
  assert.deepEqual(out.groups.map((g) => g.downloadId), ["dl6"]);
});

// ── 5: nothing secret, nothing path-like ─────────────────────────────────────

test("upstream text loses paths and URLs (a URL keeps its host) and stays one bounded line", () => {
  const s = W.scrubArrText("Import failed:\n'/downloads/complete/Movie (2020)/x.mkv' via https://idx.example/api?apikey=ABC123&t=get on C:\\Downloads\\x and \\\\nas\\share\\y; 1/2 parts and/or more");
  assert.ok(s);
  for (const leak of ["/downloads", "ABC123", "apikey", "C:\\", "\\\\nas", "(2020)", "x.mkv", "/x"]) assert.ok(!s.includes(leak), `${leak} leaked: ${s}`);
  assert.ok(s.includes("idx.example/…"), s);
  assert.ok(s.includes("1/2 parts and/or more"), `ordinary slashes were mangled: ${s}`);
  assert.ok(!s.includes("\n"));
  assert.equal(W.scrubArrText("x".repeat(1000))?.length, 300);
  assert.equal(W.scrubArrText(42), null);
});

test("a path with SPACES is removed to the end of its clause, never cut at its first space (media folders have spaces)", () => {
  const cases: Array<{ in: string; leaks: string[]; keeps?: string }> = [
    // Unquoted POSIX path ending the message.
    { in: "No files found are eligible for import in /downloads/complete/Movie Name (2020)", leaks: ["Name", "(2020)", "/downloads"], keeps: "eligible for import in …" },
    // …followed by another sentence, which survives.
    { in: "Folder is not accessible by Radarr: /mnt/user/data/torrents/My Show S01/My Show S01E01.mkv. Ensure the path exists", leaks: ["Show", "S01E01", "/mnt"], keeps: "Ensure the path exists" },
    // Windows, UNC, bracketed.
    { in: "C:\\Users\\John Doe\\Downloads\\ep.mkv", leaks: ["Doe", "ep.mkv", "Users"] },
    { in: "D:\\Downloads\\Movie Name (2020)\\movie.mkv is locked", leaks: ["Name", "(2020)", "movie.mkv"] },
    { in: "copy from \\\\nas\\share\\John Doe\\x.mkv failed", leaks: ["Doe", "x.mkv", "share"] },
    { in: "Destination already exists [/movies/A Film (2019)/A Film (2019).mkv]", leaks: ["Film", "(2019)", "/movies"], keeps: "Destination already exists […]" },
    // A clause break (", ") ends the path; the rest of the sentence stays.
    { in: "Path: /a/b c/d.mkv, quality unknown", leaks: ["/a", "d.mkv", " c/"], keeps: "quality unknown" },
  ];
  for (const c of cases) {
    const s = W.scrubArrText(c.in);
    assert.ok(s, c.in);
    for (const leak of c.leaks) assert.ok(!s.includes(leak), `${leak} leaked from ${JSON.stringify(c.in)}: ${s}`);
    if (c.keeps) assert.ok(s.includes(c.keeps), `the rest of the sentence was lost: ${s}`);
  }
});

test("a path is not cut at an apostrophe, \", \" or \". \" inside a folder or file name (Ocean's Eleven, Crouching Tiger, Mr. Robot)", () => {
  const cases: Array<{ in: string; leaks: string[]; keeps?: string }> = [
    {
      in: "Import failed, path does not exist or is not accessible by Radarr: /data/media/movies/Ocean's Eleven (2001)/Ocean's Eleven (2001) Bluray-1080p.mkv",
      leaks: ["Eleven", "(2001)", "Bluray", ".mkv", "/data"],
      keeps: "Import failed, path does not exist or is not accessible by Radarr: …",
    },
    { in: "Destination: /movies/Crouching Tiger, Hidden Dragon (2000)/Crouching Tiger, Hidden Dragon (2000).mkv", leaks: ["Hidden", "Dragon", "(2000)", ".mkv", "Tiger"] },
    { in: "Not found: /mnt/user/tv/Mr. Robot/Season 01/Mr. Robot - S01E01.mkv. Ensure the path exists", leaks: ["Robot", "Season", "S01E01", ".mkv"], keeps: "Ensure the path exists" },
    { in: "C:\\Movies\\Ocean's Eleven (2001)\\file.mkv failed", leaks: ["Eleven", "(2001)", "file.mkv", "Movies"] },
    { in: "Could not move '/data/Ocean's Eleven/x.mkv' to the library", leaks: ["Eleven", "x.mkv", "/data"], keeps: "'…' to the library" },
    // A clause break after a complete path still ends it.
    { in: "Path: /a/Mr. Robot/d.mkv, quality unknown", leaks: ["Robot", "d.mkv"], keeps: "quality unknown" },
  ];
  for (const c of cases) {
    const s = W.scrubArrText(c.in);
    assert.ok(s, c.in);
    for (const leak of c.leaks) assert.ok(!s.includes(leak), `${leak} leaked from ${JSON.stringify(c.in)}: ${s}`);
    if (c.keeps) assert.ok(s.includes(c.keeps), `the rest of the sentence was lost: ${s}`);
  }
});

// ── 3: attention ─────────────────────────────────────────────────────────────

const QI = (key: string, attention: boolean) => ({
  service: "radarr", instance: "", ids: [Number(key.replace(/\D/g, "")) || 1], downloadId: key, title: `rel-${key}`,
  mediaTitle: "Dune", year: 2021, tmdbId: 438631, tvdbId: null, arrMediaId: 5, episodes: [], quality: null, qualityTags: [],
  languages: [], customFormats: [], customFormatScore: null, size: 1, sizeLeft: 0, progress: 1, timeLeftSeconds: null,
  estimatedCompletion: null, added: null, phase: "importBlocked", pending: false, canChangeCategory: false,
  trackedStatus: "warning", messages: ["No files found are eligible for import in /downloads/x"], protocol: "torrent",
  downloadClient: null, indexer: null, outputPath: "/downloads/x", attention, requesters: [],
}) as Parameters<typeof W.diffAttention>[0][number];

const mem = (d: { keys: string[]; seen: Record<string, string> }) => ({ keys: d.keys, seen: d.seen });

test("attention: only downloads not announced before are new; a first run seeds silently", () => {
  const seeded = W.diffAttention([QI("A", true), QI("B", false)], null, T0);
  assert.deepEqual(seeded.newly, [], "downloads already stuck when the monitor started are not 'new'");
  assert.equal(seeded.keys.length, 1);
  const next = W.diffAttention([QI("A", true), QI("C", true)], mem(seeded), T0 + 15 * MIN);
  assert.deepEqual(next.newly.map((i) => i.downloadId), ["C"]);
  // Leaving attention and coming back within a day is the same stuck download, not news…
  const cleared = W.diffAttention([QI("A", false), QI("C", true)], mem(next), T0 + 30 * MIN);
  assert.deepEqual(cleared.newly, []);
  assert.deepEqual(W.diffAttention([QI("A", true), QI("C", true)], mem(cleared), T0 + 45 * MIN).newly, []);
  // …and a day after it was last seen stuck, it is.
  const later = W.diffAttention([QI("C", true)], mem(cleared), T0 + 24 * 60 * MIN);
  assert.deepEqual(W.diffAttention([QI("A", true), QI("C", true)], mem(later), T0 + 24 * 60 * MIN + 31 * MIN).newly.map((i) => i.downloadId), ["A"]);
});

test("attention: a stuck download missing from one successful read and back is NOT re-announced (arr restart, dark client, paging)", () => {
  const first = W.diffAttention([QI("A", true)], null, T0);
  const gone = W.diffAttention([], mem(first), T0 + 15 * MIN);
  assert.deepEqual(gone.keys, [], "the badge counts what is stuck now");
  assert.ok(gone.seen["d:A:5"], "…but the announcement is remembered");
  const back = W.diffAttention([QI("A", true)], mem(gone), T0 + 30 * MIN);
  assert.deepEqual(back.newly, []);
});

test("attention: at most 25 per instance per run — the rest are announced by the NEXT run, never dropped", () => {
  const seeded = W.diffAttention([], null, T0);
  const stuck = Array.from({ length: 30 }, (_, i) => QI(`K${i + 1}`, true));
  const first = W.diffAttention(stuck, mem(seeded), T0 + 15 * MIN);
  assert.equal(first.newly.length, W.MAX_ATTENTION_PER_RUN);
  assert.equal(first.deferred, 5);
  assert.equal(first.keys.length, 30, "the badge still counts every stuck download");
  const second = W.diffAttention(stuck, mem(first), T0 + 30 * MIN);
  assert.deepEqual(second.newly.map((i) => i.downloadId), ["K26", "K27", "K28", "K29", "K30"]);
  assert.equal(second.deferred, 0);
  assert.deepEqual(W.diffAttention(stuck, mem(second), T0 + 45 * MIN).newly, []);
});

test("attention: a queue read gap longer than the grace does NOT re-announce a download that stayed stuck (an outage is unobserved time)", () => {
  const seeded = W.diffAttention([QI("A", true)], null, T0);
  const read = W.diffAttention([QI("A", true)], mem(seeded), T0 + 15 * MIN);
  const readAt = iso(T0 + 15 * MIN);
  // 26 h with no successful read, A still stuck: not news; B is.
  const back = W.diffAttention([QI("A", true), QI("B", true)], { ...mem(read), readAt }, T0 + 15 * MIN + 26 * 60 * MIN);
  assert.deepEqual(back.newly.map((i) => i.downloadId), ["B"]);
  // A key that dropped off before the outage keeps its OBSERVED remainder after it, too.
  const dropped = W.diffAttention([], { ...mem(read), readAt }, T0 + 30 * MIN);
  const afterOutage = W.diffAttention([], { ...mem(dropped), readAt: iso(T0 + 30 * MIN) }, T0 + 30 * MIN + 26 * 60 * MIN);
  const next = W.diffAttention([QI("A", true)], { ...mem(afterOutage), readAt: iso(T0 + 30 * MIN + 26 * 60 * MIN) }, T0 + 45 * MIN + 26 * 60 * MIN);
  assert.deepEqual(next.newly, [], "the outage was counted on the run after it");
  // Regular reads age exactly as before: last seen 24h10m ago, read 15 min ago ⇒ news again.
  const now = T0 + 48 * 60 * MIN;
  const aged = W.diffAttention([QI("A", true)], { keys: [], seen: { "d:A:5": iso(now - 24 * 60 * MIN - 10 * MIN) }, readAt: iso(now - 15 * MIN) }, now);
  assert.deepEqual(aged.newly.map((i) => i.downloadId), ["A"]);
  // The stamp round-trips through the stored state; junk is dropped.
  assert.equal(W.parseArrWatchState(JSON.stringify({ instances: { "radarr:": { attentionReadAt: readAt } } })).instances["radarr:"].attentionReadAt, readAt);
  assert.equal(W.parseArrWatchState(JSON.stringify({ instances: { "radarr:": { attentionReadAt: "soon" } } })).instances["radarr:"].attentionReadAt, undefined);
});

test("attention: the read gap follows the cadence — a DAILY monitor's regular gap is observed time, so a key is forgotten a day after it was last seen", () => {
  assert.equal(W.attentionReadGapMs(900), W.ATTENTION_READ_GAP_MS, "the default 15-minute cadence keeps the 1 h floor");
  assert.equal(W.attentionReadGapMs(86400), 48 * 60 * MIN);
  const gap = W.attentionReadGapMs(86400);
  const DAY = 24 * 60 * MIN;
  const seen = W.diffAttention([QI("A", true)], { keys: [], seen: {}, readAt: iso(T0 - DAY) }, T0, W.MAX_ATTENTION_PER_RUN, gap);
  // Day 1: A dropped off; last seen exactly a day ago — still remembered.
  const day1 = W.diffAttention([], { ...mem(seen), readAt: iso(T0) }, T0 + DAY, W.MAX_ATTENTION_PER_RUN, gap);
  assert.equal(day1.seen["d:A:5"], iso(T0), "a regular daily gap must not move the last-seen time forward");
  // Day 2: stuck again, 48 h after it was last seen — that is news.
  const day2 = W.diffAttention([QI("A", true)], { ...mem(day1), readAt: iso(T0 + DAY) }, T0 + 2 * DAY, W.MAX_ATTENTION_PER_RUN, gap);
  assert.deepEqual(day2.newly.map((i) => i.downloadId), ["A"], "a fixed 1 h gap kept A for ~25 days at a daily cadence");
  // At a 2-hour cadence a 26-hour outage is still unobserved time: a download
  // stuck through it is not news (only the gap past 4 h is discounted).
  const gap2h = W.attentionReadGapMs(7200);
  const outage = W.diffAttention([QI("A", true)], { keys: [], seen: { "d:A:5": iso(T0) }, readAt: iso(T0) }, T0 + 26 * 60 * MIN, W.MAX_ATTENTION_PER_RUN, gap2h);
  assert.deepEqual(outage.newly, []);
  // …and its regular 2-hour gaps age the memory exactly: forgotten a day after last seen.
  let m: { keys: string[]; seen: Record<string, string> } = { keys: [], seen: { "d:A:5": iso(T0) } };
  for (let h = 2; h <= 24; h += 2) m = W.diffAttention([], { ...m, readAt: iso(T0 + (h - 2) * 60 * MIN) }, T0 + h * 60 * MIN, W.MAX_ATTENTION_PER_RUN, gap2h);
  assert.ok(m.seen["d:A:5"], "remembered through a day of regular reads");
  const after = W.diffAttention([QI("A", true)], { ...m, readAt: iso(T0 + 24 * 60 * MIN) }, T0 + 26 * 60 * MIN, W.MAX_ATTENTION_PER_RUN, gap2h);
  assert.deepEqual(after.newly.map((i) => i.downloadId), ["A"], "a 2 h cadence with a fixed 1 h gap remembered it ~50 h");
});

test("attention: a state stored before the memory existed (keys only) seeds it — no replay on upgrade", () => {
  const out = W.diffAttention([QI("A", true), QI("C", true)], { keys: ["d:A:5"] }, T0);
  assert.deepEqual(out.newly.map((i) => i.downloadId), ["C"]);
  const parsed = W.parseArrWatchState(JSON.stringify({ instances: { "radarr:": { attention: ["d:A:5"], attentionSeen: { "d:A:5": iso(T0), bad: "no" }, goneDisks: { "/m": { state: "low", at: iso(T0) }, "/x": { state: "full", at: iso(T0) } } } } }));
  assert.deepEqual(parsed.instances["radarr:"].attentionSeen, { "d:A:5": iso(T0) });
  assert.deepEqual(parsed.instances["radarr:"].goneDisks, { "/m": { state: "low", at: iso(T0) } });
});

test("an attention event carries no output path and no file path from the arr's message", () => {
  const ev = W.attentionEvent({ service: "radarr", slug: "4k", name: "4K" }, QI("A", true));
  const json = JSON.stringify(ev);
  assert.ok(!json.includes("/downloads"), json);
  assert.equal(ev.arr?.instanceName, "4K");
  assert.equal(ev.media?.tmdbId, 438631);
});

// ── the catalog, the payload, the link, the text ─────────────────────────────

test("the four monitor events are subscribable and route to the page that can act on them", () => {
  for (const e of ["arr.disk_low", "arr.disk_ok", "arr.download_failed", "arr.queue_attention"]) {
    assert.ok((NOTIFY_EVENT_KEYS as readonly string[]).includes(e), e);
  }
  const media = { type: "MOVIE" as const, tmdbId: 5, title: "x" };
  const arr = { service: "sonarr" as const, instance: "anime" };
  assert.equal(eventLink({ event: "arr.download_failed", media, arr }, "https://s"), "https://s/admin/arr-history?service=sonarr&instance=anime&kind=failed",
    "the arr page wins over the title page — the download is what needs acting on");
  assert.equal(eventLink({ event: "arr.queue_attention", media, arr }, "https://s"), "https://s/admin/queue");
  assert.equal(eventLink({ event: "arr.disk_low", arr }, "https://s"), "https://s/admin/arr-system?tab=storage");
  assert.equal(eventLink({ event: "request.approved", media }, "https://s"), "https://s/movie/5", "other events keep their links");
});

test("payload: an additive `arr` object on the monitor's events, null on every other", () => {
  const ctx = { siteUrl: null, title: "", message: "", mediaTitle: null, timestamp: "" };
  const p = buildWebhookPayload({ event: "arr.disk_low", arr: { service: "radarr", instance: "", path: "/m", freeBytes: 5, totalBytes: 100, freePercent: 5, thresholdPercent: 10 } }, ctx);
  assert.equal(p.version, 1);
  assert.deepEqual(p.arr, { service: "radarr", instance: "", instanceName: null, path: "/m", freeBytes: 5, totalBytes: 100, freePercent: 5, thresholdPercent: 10, release: null, downloadId: null, episodes: null });
  assert.equal(buildWebhookPayload({ event: "request.created" }, ctx).arr, null);
});

test("text: the disk body names size and share, and drops to the no-size wording when the arr reports none", () => {
  const withTotal = renderAgentText({ event: "arr.disk_low", arr: { service: "radarr", instance: "4k", instanceName: "4K", path: "/m", freeBytes: 42_500_000_000, totalBytes: 1_000_000_000_000, freePercent: 4.3 } }, null);
  assert.equal(withTotal.title, "Low disk space on Radarr (4K)");
  assert.equal(withTotal.message, "/m has 42.5 GB free of 1 TB (4.3%).");
  const noTotal = renderAgentText({ event: "arr.disk_low", arr: { service: "radarr", instance: "", path: "//nas/m", freeBytes: 8 * GB, totalBytes: null, freePercent: null } }, null);
  assert.equal(noTotal.title, "Low disk space on Radarr");
  assert.equal(noTotal.message, "//nas/m has only 8 GB free.");
  const failed = renderAgentText({ event: "arr.download_failed", text: "Unpack failed", arr: { service: "sonarr", instance: "", release: "Show.S01" } }, null);
  assert.equal(failed.title, "Download failed: Show.S01", "a download matched to no title is named by its release");
  assert.equal(failed.message, "Sonarr could not download Show.S01: Unpack failed");
});

// ── 4 + end-to-end: the run ──────────────────────────────────────────────────

test("first run: a low disk is announced; history and the queue are SEEDED, not replayed", async () => {
  const f = configureRadarr();
  radarrDisk(f, 30); // 3% of 1 TB
  f.history = [radarrFailure(1, T0 - 60 * MIN)];
  f.queue = [queueRecord(1, "OLD", true)];
  const r = await runArrWatch({ now: T0 });
  await settle();
  assert.deepEqual(r.events, { diskLow: 1, diskOk: 0, downloadFailed: 0, queueAttention: 0 });
  assert.deepEqual(arrCalls(RADARR, "/api/v3/history/since"), [], "a first run reads no history at all");
  const [d] = deliveries();
  assert.equal(d.event, "arr.disk_low");
  assert.equal(d.arr?.path, "/movies", "the container root (also nearly full) is not a media disk");
  assert.equal(d.url, "https://summon.example/admin/arr-system?tab=storage");
  assert.deepEqual(r.summary, { attention: 1, lowDisks: 1, failed24h: 0 });
  assert.deepEqual(JSON.parse(settings.get(ARR_WATCH_SUMMARY_KEY)!).attention, 1);
});

test("next run: each new failure once (masked), each newly stuck download once; a disk still low stays quiet", async () => {
  const f = configureRadarr();
  radarrDisk(f, 30);
  f.queue = [queueRecord(1, "OLD", true)];
  await runArrWatch({ now: T0 });
  await settle();
  calls = [];
  f.history = [radarrFailure(1, T0 - 60 * MIN), radarrFailure(2, T0 + 5 * MIN)];
  f.queue = [queueRecord(1, "OLD", true), queueRecord(2, "NEW", true), queueRecord(3, "FINE", false)];
  const r = await runArrWatch({ now: T0 + 15 * MIN });
  await settle();
  assert.deepEqual(r.events, { diskLow: 0, diskOk: 0, downloadFailed: 1, queueAttention: 1 });
  const since = arrCalls(RADARR, "/api/v3/history/since")[0];
  assert.equal(since.query.get("eventType"), "4", "DownloadFailed is 4 in both arrs");
  assert.equal(since.query.get("date"), iso(T0 - 14 * 60 * MIN), "read from the seeded cursor, less the time-zone overlap");
  const byEvent = Object.fromEntries(deliveries().map((d) => [d.event, d]));
  const failed = byEvent["arr.download_failed"];
  assert.equal(failed.media?.title, "Arrival");
  assert.equal(failed.arr?.release, "Arrival.2016.1080p.2");
  assert.equal(failed.url, "https://summon.example/admin/arr-history?service=radarr&instance=&kind=failed");
  const all = JSON.stringify(deliveries());
  for (const leak of ["/downloads", "SECRET123", "apikey"]) assert.ok(!all.includes(leak), `${leak} reached a channel`);
  assert.equal(byEvent["arr.queue_attention"].arr?.downloadId, "NEW");
  assert.equal(JSON.parse(settings.get(ARR_WATCH_SUMMARY_KEY)!).failed24h, 1);

  // A third run over the same upstream: nothing new.
  calls = [];
  const again = await runArrWatch({ now: T0 + 30 * MIN });
  await settle();
  assert.deepEqual(again.events, { diskLow: 0, diskOk: 0, downloadFailed: 0, queueAttention: 0 });
  assert.deepEqual(deliveries(), []);
});

test("an arr without /history/since falls back to the newest page of failures, filtered by the cursor", async () => {
  const f = configureRadarr();
  f.noSince = true;
  await runArrWatch({ now: T0 });
  f.history = [radarrFailure(1, T0 - 60 * MIN), radarrFailure(2, T0 + 5 * MIN)];
  const r = await runArrWatch({ now: T0 + 15 * MIN });
  assert.equal(r.events.downloadFailed, 1);
  const page = arrCalls(RADARR, "/api/v3/history")[0];
  assert.equal(page.query.get("eventType"), "4");
  assert.equal(page.query.get("sortDirection"), "descending");
});

test("a Sonarr pack failing is ONE event with its episode count; instances are isolated", async () => {
  settings.set("radarrUrl", RADARR);
  settings.set("radarrApiKey", "radarr-key");
  settings.set("sonarrUrl", SONARR);
  settings.set("sonarrApiKey", "sonarr-key");
  const radarr = fixture(RADARR);
  radarr.down = new Set(["/api/v3/rootfolder", "/api/v3/diskspace", "/api/v3/queue", "/api/v3/history/since"]);
  const sonarr = fixture(SONARR);
  radarrDisk(sonarr, 500);
  await runArrWatch({ now: T0 });
  await settle();
  calls = [];
  const ep = (id: number, n: number) => ({
    id, seriesId: 3, episodeId: 100 + n, sourceTitle: "GoT.S01.1080p", date: iso(T0 + MIN), downloadId: "PACK", eventType: "downloadFailed",
    data: { message: "Repair failed" }, series: { tmdbId: 1399, tvdbId: 121361, title: "Game of Thrones" }, episode: { seasonNumber: 1, episodeNumber: n, title: "" },
  });
  sonarr.history = [ep(1, 1), ep(2, 2), ep(3, 3)];
  const r = await runArrWatch({ now: T0 + 15 * MIN });
  await settle();
  assert.equal(r.events.downloadFailed, 1);
  const [d] = deliveries();
  assert.equal(d.arr?.episodes, 3);
  assert.equal(d.media?.title, "Game of Thrones");
  assert.deepEqual(new Set(r.errors.map((e) => `${e.service}:${e.part}`)), new Set(["radarr:disk", "radarr:history", "radarr:queue"]),
    "the dark Radarr is named per part; the healthy Sonarr still ran");
  // A dark instance is ONE line per unchanged condition (guardrail 7b), not one per run.
  const before = warns.length;
  await runArrWatch({ now: T0 + 30 * MIN });
  assert.equal(warns.length, before, "an unchanged failure re-logged");
});

test("a failed read keeps that part's previous state — a dark run is not 'nothing stuck', and the next good run announces nothing old", async () => {
  const f = configureRadarr();
  f.queue = [queueRecord(1, "A", true)];
  await runArrWatch({ now: T0 });
  f.down = new Set(["/api/v3/queue"]);
  const dark = await runArrWatch({ now: T0 + 15 * MIN });
  assert.equal(dark.summary.attention, 1, "the stored attention set survived the failed read");
  f.down = new Set();
  calls = [];
  const back = await runArrWatch({ now: T0 + 30 * MIN });
  await settle();
  assert.equal(back.events.queueAttention, 0);
});

test("run: a failure the arr dated days ahead waits; the genuine failures around it are announced on time", async () => {
  const f = configureRadarr();
  await runArrWatch({ now: T0 });
  f.history = [radarrFailure(1, T0 + 3 * 24 * 60 * MIN), radarrFailure(2, T0 + 5 * MIN)];
  const first = await runArrWatch({ now: T0 + 15 * MIN });
  assert.equal(first.events.downloadFailed, 1, "the future-dated record was consumed");
  const cursor = W.parseArrWatchState(settings.get(ARR_WATCH_STATE_KEY)).instances["radarr:"].history?.cursor;
  assert.deepEqual(cursor, { at: iso(T0 + 5 * MIN), lastId: 2 });
  f.history.push(radarrFailure(3, T0 + 20 * MIN));
  assert.equal((await runArrWatch({ now: T0 + 30 * MIN })).events.downloadFailed, 1, "a later genuine failure fell behind a future cursor");
  await settle();
});

test("run: a queue outage longer than a day does not re-announce a download stuck through it — a failed read keeps the last-read stamp", async () => {
  const f = configureRadarr();
  await runArrWatch({ now: T0 });
  f.queue = [queueRecord(1, "A", true)];
  assert.equal((await runArrWatch({ now: T0 + 15 * MIN })).events.queueAttention, 1);
  const stamp = () => W.parseArrWatchState(settings.get(ARR_WATCH_STATE_KEY)).instances["radarr:"].attentionReadAt;
  assert.equal(stamp(), iso(T0 + 15 * MIN));
  f.down = new Set(["/api/v3/queue"]);
  for (let h = 1; h <= 26; h++) await runArrWatch({ now: T0 + 15 * MIN + h * 60 * MIN });
  assert.equal(stamp(), iso(T0 + 15 * MIN), "a failed queue read moved the last-read stamp");
  f.down = new Set();
  await settle();
  calls = [];
  const back = await runArrWatch({ now: T0 + 15 * MIN + 27 * 60 * MIN });
  await settle();
  assert.equal(back.events.queueAttention, 0, "a download stuck through the outage was announced as newly stuck");
  assert.equal(stamp(), iso(T0 + 15 * MIN + 27 * 60 * MIN));
});

test("run: at ARR_WATCH_INTERVAL=86400 the attention memory is a day, not ~25 — the route passes the cadence's read gap", async () => {
  process.env.ARR_WATCH_INTERVAL = "86400";
  try {
    const DAY = 24 * 60 * MIN;
    const f = configureRadarr();
    await runArrWatch({ now: T0 });
    f.queue = [queueRecord(1, "A", true)];
    assert.equal((await runArrWatch({ now: T0 + 15 * MIN })).events.queueAttention, 1);
    f.queue = [];
    await runArrWatch({ now: T0 + 15 * MIN + DAY });
    f.queue = [queueRecord(1, "A", true)];
    await settle();
    calls = [];
    const back = await runArrWatch({ now: T0 + 15 * MIN + 2 * DAY });
    await settle();
    assert.equal(back.events.queueAttention, 1, "stuck again two days after it was last seen is news at a daily cadence");
  } finally {
    delete process.env.ARR_WATCH_INTERVAL;
  }
});

test("run: a stuck download that drops off ONE successful queue read and comes back is not announced again", async () => {
  const f = configureRadarr();
  await runArrWatch({ now: T0 });
  f.queue = [queueRecord(1, "A", true)];
  const announced = await runArrWatch({ now: T0 + 15 * MIN });
  assert.equal(announced.events.queueAttention, 1);
  f.queue = []; // the arr restarted and hasn't reloaded its tracked downloads yet
  const gone = await runArrWatch({ now: T0 + 30 * MIN });
  assert.equal(gone.summary.attention, 0);
  f.queue = [queueRecord(1, "A", true)];
  await settle();
  calls = [];
  const back = await runArrWatch({ now: T0 + 45 * MIN });
  await settle();
  assert.equal(back.events.queueAttention, 0);
  assert.deepEqual(deliveries(), []);
});

test("run: a whole queue blocked at once is announced 25 at a time — the rest by the next run", async () => {
  const f = configureRadarr();
  await runArrWatch({ now: T0 });
  f.queue = Array.from({ length: 30 }, (_, i) => queueRecord(i + 1, `Q${i + 1}`, true));
  const first = await runArrWatch({ now: T0 + 15 * MIN });
  assert.equal(first.events.queueAttention, 25);
  assert.equal(first.deferredAttention, 5);
  assert.equal(first.summary.attention, 30);
  const second = await runArrWatch({ now: T0 + 30 * MIN });
  assert.equal(second.events.queueAttention, 5);
  assert.equal(second.deferredAttention, 0);
});

test("run: a low disk whose root folder is briefly inaccessible is not announced again when it comes back", async () => {
  const f = configureRadarr();
  radarrDisk(f, 30);
  await runArrWatch({ now: T0 });
  await settle();
  f.rootfolder = [{ id: 1, path: "/movies", accessible: false, freeSpace: null }];
  const dark = await runArrWatch({ now: T0 + 15 * MIN });
  assert.deepEqual(dark.events, { diskLow: 0, diskOk: 0, downloadFailed: 0, queueAttention: 0 });
  radarrDisk(f, 30);
  calls = [];
  const back = await runArrWatch({ now: T0 + 30 * MIN });
  await settle();
  assert.equal(back.events.diskLow, 0);
  assert.deepEqual(deliveries(), []);
});

test("a dark disk read keeps the disk's state: a disk still low when the read comes back is not announced again", async () => {
  const f = configureRadarr();
  radarrDisk(f, 30);
  await runArrWatch({ now: T0 });
  await settle();
  f.down = new Set(["/api/v3/diskspace"]);
  const dark = await runArrWatch({ now: T0 + 15 * MIN });
  assert.equal(dark.summary.lowDisks, 1, "a failed read is not 'every disk recovered'");
  f.down = new Set();
  calls = [];
  const back = await runArrWatch({ now: T0 + 30 * MIN });
  await settle();
  assert.deepEqual(back.events, { diskLow: 0, diskOk: 0, downloadFailed: 0, queueAttention: 0 });
  assert.deepEqual(deliveries(), []);
});

test("STATE FIRST: a failed state write sends nothing, and the next run announces the same events once", async () => {
  const f = configureRadarr();
  await runArrWatch({ now: T0 });
  await settle();
  calls = [];
  radarrDisk(f, 30);
  failStateWrite = true;
  await assert.rejects(runArrWatch({ now: T0 + 15 * MIN }), /db down/);
  await settle();
  assert.deepEqual(deliveries(), [], "an event went out for a state that was never stored");
  failStateWrite = false;
  const r = await runArrWatch({ now: T0 + 30 * MIN });
  await settle();
  assert.equal(r.events.diskLow, 1);
  assert.equal(deliveries().length, 1);
});

test("guardrail 41: a run whose AbortSignal fired stores nothing and sends nothing", async () => {
  const f = configureRadarr();
  radarrDisk(f, 30);
  const controller = new AbortController();
  // Fires while the instance is being read — after the run started.
  const realQueue = f.queue;
  Object.defineProperty(f, "queue", { get: () => { controller.abort(new Error("lock timeout")); return realQueue; }, configurable: true });
  const r = await runArrWatch({ now: T0, signal: controller.signal });
  await settle();
  assert.equal(r.aborted, true);
  assert.deepEqual(settingWrites, [], "an aborted run wrote state the next run may already be reading");
  assert.deepEqual(deliveries(), []);
  // Aborted before the first instance: nothing is read either.
  calls = [];
  const pre = new AbortController();
  pre.abort();
  const r2 = await runArrWatch({ now: T0, signal: pre.signal });
  assert.equal(r2.notReached, 1);
  assert.deepEqual(arrCalls(RADARR), []);
});

test("C101 guardrail 41: the queue walk observes the lock's signal — no page is read after the abort", async () => {
  const f = configureRadarr();
  radarrDisk(f, 30);
  f.queue = [queueRecord(1, "A", true)];
  f.queueTotal = 600; // three pages of 250
  const controller = new AbortController();
  f.onQueuePage = (page) => { if (page === 1) controller.abort(new Error("lock timeout")); };
  const r = await runArrWatch({ now: T0, signal: controller.signal });
  await settle();
  const pages = arrCalls(RADARR, "/api/v3/queue").map((c) => c.query.get("page"));
  assert.deepEqual(pages, ["1"], "page 2 was read after the lock was released");
  assert.equal(r.aborted, true);
  assert.deepEqual(settingWrites, []);
  assert.deepEqual(deliveries(), []);
});

test("C101 guardrail 41: readQueuePages RETURNS what it has on an abort — it never throws for one", async () => {
  const { readQueuePages } = await import("../src/lib/arr-queue-data.ts");
  const f = configureRadarr();
  f.queue = [queueRecord(1, "A", true)];
  f.queueTotal = 600;
  const controller = new AbortController();
  f.onQueuePage = (page) => { if (page === 1) controller.abort(new Error("lock timeout")); };
  const records = await readQueuePages("radarr", "", controller.signal);
  assert.equal(records.length, 1, "page 1's records, and no page after the abort");
  assert.deepEqual(arrCalls(RADARR, "/api/v3/queue").map((c) => c.query.get("page")), ["1"]);
});

test("C101 guardrail 41: a queue page IN FLIGHT when the lock aborts is cancelled, and the walk returns rather than throws", async () => {
  const { readQueuePages } = await import("../src/lib/arr-queue-data.ts");
  const f = configureRadarr();
  f.queue = [queueRecord(1, "A", true)];
  f.queueTotal = 600;
  f.queueHangPage = 2;
  const controller = new AbortController();
  const walk = readQueuePages("radarr", "", controller.signal);
  for (let i = 0; i < 200 && arrCalls(RADARR, "/api/v3/queue").length < 2; i++) await new Promise((r) => setImmediate(r));
  assert.equal(arrCalls(RADARR, "/api/v3/queue").length, 2, "page 2 is in flight");
  controller.abort(new Error("lock timeout"));
  const records = await walk;
  assert.equal(records.length, 1, "page 1's records — the cancelled page adds nothing, and nothing is thrown");
});

test("C101: without an abort the monitor's queue walk still reads every page", async () => {
  const f = configureRadarr();
  radarrDisk(f, 30);
  f.queue = [queueRecord(1, "A", true)];
  f.queueTotal = 600;
  await runArrWatch({ now: T0, signal: new AbortController().signal });
  assert.deepEqual(arrCalls(RADARR, "/api/v3/queue").map((c) => c.query.get("page")), ["1", "2", "3"]);
});

test("an instance no longer configured is dropped from the state, so coming back re-seeds instead of replaying", async () => {
  configureRadarr();
  await runArrWatch({ now: T0 });
  assert.ok(JSON.parse(settings.get(ARR_WATCH_STATE_KEY)!).instances["radarr:"]);
  settings.set("feature.integration.radarr", "false");
  invalidateFeatureFlagCache();
  await runArrWatch({ now: T0 + 15 * MIN });
  assert.deepEqual(JSON.parse(settings.get(ARR_WATCH_STATE_KEY)!).instances, {});
});

// ── 7: the nav badge ─────────────────────────────────────────────────────────

test("nav badge: the attention count from ONE row; none when zero, stale, corrupt or unreadable", async () => {
  const now = Date.now();
  settings.set(ARR_WATCH_SUMMARY_KEY, JSON.stringify({ at: iso(now - 5 * MIN), attention: 3, lowDisks: 0, failed24h: 0 }));
  assert.deepEqual(await readArrWatchNavBadges(), { "/admin/queue": 3 });
  settings.set(ARR_WATCH_SUMMARY_KEY, JSON.stringify({ at: iso(now - 5 * MIN), attention: 0, lowDisks: 2, failed24h: 0 }));
  assert.equal(await readArrWatchNavBadges(), undefined);
  settings.set(ARR_WATCH_SUMMARY_KEY, JSON.stringify({ at: iso(now - 2 * 60 * MIN), attention: 3, lowDisks: 0, failed24h: 0 }));
  assert.equal(await readArrWatchNavBadges(), undefined, "a monitor that stopped must not leave its count up");
  settings.set(ARR_WATCH_SUMMARY_KEY, "{not json");
  assert.equal(await readArrWatchNavBadges(), undefined);
  const real = (prisma as unknown as { setting: { findUnique: unknown } }).setting.findUnique;
  (prisma as unknown as { setting: { findUnique: unknown } }).setting.findUnique = async () => { throw new Error("db down"); };
  try {
    assert.equal(await readArrWatchNavBadges(), undefined, "a failed read must fail OPEN — no badge, no broken page");
  } finally {
    (prisma as unknown as { setting: { findUnique: unknown } }).setting.findUnique = real;
  }
});

test("the badge's staleness bound follows ARR_WATCH_INTERVAL (three intervals, at least an hour)", () => {
  const s = { at: iso(T0), attention: 2, lowDisks: 0, failed24h: 0 };
  assert.equal(W.queueBadgeCount(s, T0 + 59 * MIN, 60 * MIN), 2);
  assert.equal(W.queueBadgeCount(s, T0 + 61 * MIN, 60 * MIN), null);
  assert.equal(W.arrWatchIntervalSeconds("3600"), 3600);
  assert.equal(W.arrWatchIntervalSeconds("15m"), 900);
  assert.equal(W.arrWatchIntervalSeconds("0900"), 900, "octal-ambiguous, as _cron_int reads it");
});

// ── 6: the route ─────────────────────────────────────────────────────────────

const cronReq = () => new NextRequest("http://localhost:3000/api/cron/arr-watch", { method: "POST", headers: { authorization: `Bearer ${CRON_SECRET}` } });

test("route: with neither integration on, or nothing configured, it skips BEFORE its lock and writes no ledger row", async () => {
  settings.set("feature.integration.radarr", "false");
  settings.set("feature.integration.sonarr", "false");
  settings.set("radarrUrl", RADARR);
  settings.set("radarrApiKey", "k");
  let res = await cronPost(cronReq());
  assert.deepEqual(await res.json(), { skipped: true, reason: "no Radarr/Sonarr instance configured" });
  assert.equal(res.headers.get("X-Cron-Skipped"), "1");
  settings.clear();
  invalidateFeatureFlagCache();
  res = await cronPost(cronReq());
  assert.equal((await res.json()).skipped, true, "integrations on by default but nothing configured");
  assert.deepEqual(lockCalls, []);
  assert.deepEqual(settingWrites, []);
});

test("route: takes and releases its own lock; an unreadable instance is a 200 marked degraded, and the ledger says failed", async () => {
  const f = configureRadarr();
  f.down = new Set(["/api/v3/queue"]);
  const res = await cronPost(cronReq());
  assert.equal(res.status, 200);
  const body = await res.json() as { ok: boolean; error?: string; errors: unknown[] };
  assert.equal(body.ok, false);
  assert.match(body.error ?? "", /read\(s\) failed/);
  assert.equal(res.headers.get("x-cron-degraded"), "1");
  assert.deepEqual(lockCalls, [{ op: "try", id: ARR_WATCH_LOCK_ID }, { op: "unlock", id: ARR_WATCH_LOCK_ID }]);
  assert.equal(JSON.parse(settings.get("cron:lastRun:arr-watch")!).ok, false);
  f.down = new Set();
  const clean = await cronPost(cronReq());
  const cleanBody = await clean.json() as { ok: boolean; error?: string };
  assert.equal(cleanBody.ok, true);
  assert.equal(cleanBody.error, undefined, "a clean run carries no error key — the Run-now badge reads it as failure");
  assert.equal(clean.headers.get("x-cron-degraded"), null);
  assert.equal(JSON.parse(settings.get("cron:lastRun:arr-watch")!).ok, true);
});

test("the lock id is the monitor's own", () => {
  assert.equal(ARR_WATCH_LOCK_ID, 2051);
});
