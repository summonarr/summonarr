// Audit fixes F008–F013: every projection over an upstream Radarr/Sonarr list
// is linear and bounded, whatever the arr sends. arrFetch caps a response only
// by SIZE (50 MB — hundreds of thousands of entries), and these projections run
// synchronously on the one event loop: from the arr-watch cron every
// ARR_WATCH_INTERVAL with nobody signed in, the Arr System tabs and the title
// manager (and their background snapshot refresh). An `out.some(...)` dedupe
// was O(n²), and projectRootFolders' rootDisk matching O(roots × disks): a
// hostile or MITM'd arr froze the whole process for minutes to hours per read.
//
// What is pinned, without timing:
//   1. Each projection keeps at most its exported cap (100k distinct entries in).
//   2. Each READS at most PROJECTION_SCAN_FACTOR × its cap of the raw list — a
//      Proxy counts element reads — so junk and duplicates are bounded too.
//   3. Dedupe is a Set: no per-entry scan of the kept list (Array.prototype
//      search methods are counted while a projection runs), first-seen wins.
//   4. projectRootFolders' roots × disks matching is bounded by the two caps,
//      and each path is made comparable once per projection, not per pair.
//   5. The Download Queue fold (foldQueueRecords, also run by the arr-watch
//      cron and the Why? status) is under the same rule: a record's messages,
//      languages and custom formats, and a Sonarr pack's episodes.
//   6. The Calendar's and the Missing page's per-instance projections
//      (radarr/sonarrCalendarEntries, missingMovieList/missingSeriesList) keep
//      at most MAX_CALENDAR_ENTRIES / MAX_MISSING_ITEMS and read a bounded
//      prefix, so the per-instance merge never sees an upstream-sized list: the
//      review's 130k-entry answer used to throw RangeError out of a spread push
//      and take every instance's entries down with it.
//   7. The paged readers (readQueuePages, the calendar's readQueue,
//      readCutoffPages) keep at most one page's worth per page, appended one by
//      one, and at most MAX_PAGES × PAGE_SIZE in all, whatever one page holds.
//
// 6 and 7 run the real readers and loaders over a scripted Radarr/Sonarr on
// RFC1918 literals (admin SSRF mode, no DNS) and in-memory prisma stubs.
import { test } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";
import { readFileSync } from "node:fs";

import * as S from "../src/lib/arr-system.ts";
import * as T from "../src/lib/arr-title.ts";
import * as Q from "../src/lib/arr-queue.ts";
import * as C from "../src/lib/arr-calendar.ts";
import * as M from "../src/lib/arr-missing.ts";
import { readDisks } from "../src/lib/arr-watch.ts";

// ── harness for 6 and 7 (set up before any test runs) ───────────────────────

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "projection-bounds-test-secret-0123456789";
process.env.AUTH_URL = "http://localhost:3000";
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

const fakeLookup = async () => [{ address: "10.0.0.250", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) throw new Error("could not stub dns.lookup");

const RADARR = "http://10.0.0.5:7878";
const SONARR = "http://10.0.0.7:8989";
/** What each scripted `origin + pathname` answers. */
const answers = new Map<string, (url: URL) => unknown>();
/** Every paged request served: its path, page and requested page size. */
let served: Array<{ path: string; page: number; pageSize: number }> = [];

globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const answer = answers.get(`${url.origin}${url.pathname}`);
  if (!answer) throw new Error(`unscripted ${url.href}`);
  return new Response(JSON.stringify(answer(url)), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel } = await import("./_helpers.mts");
const settings = new Map<string, string>([
  ["radarrUrl", RADARR], ["radarrApiKey", "radarr-key"],
  ["sonarrUrl", SONARR], ["sonarrApiKey", "sonarr-key"],
]);
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
shadowPrismaModel(prisma, "tmdbMediaCore", { findMany: async () => [] });

const queueData = await import("../src/lib/arr-queue-data.ts");
const calendarData = await import("../src/lib/arr-calendar-data.ts");
const missingData = await import("../src/lib/arr-missing-data.ts");

const BIG = 100_000;

/** `arr` behind a Proxy that counts element (index) reads. */
function counted<V>(arr: V[]): { list: V[]; reads: () => number } {
  let n = 0;
  const list = new Proxy(arr, {
    get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) n++;
      return Reflect.get(target, key, receiver);
    },
  });
  return { list, reads: () => n };
}

/**
 * How many elements Array.prototype.some/find/findIndex/includes/indexOf were
 * asked to search while `fn` ran — the shape of an `out.some(...)` dedupe.
 */
function searchVisits(fn: () => void): number {
  const proto = Array.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
  const names = ["some", "find", "findIndex", "includes", "indexOf"] as const;
  const originals = names.map((name) => proto[name]);
  let visits = 0;
  names.forEach((name, i) => {
    const original = originals[i];
    proto[name] = function (this: unknown[], ...args: unknown[]) {
      visits += this.length;
      return original.apply(this, args);
    };
  });
  try {
    fn();
  } finally {
    names.forEach((name, i) => {
      proto[name] = originals[i];
    });
  }
  return visits;
}

const distinctDisks = (n: number) => Array.from({ length: n }, (_, i) => ({ path: `/mnt/d${i}`, freeSpace: 1e12, totalSpace: 2e12 }));
const distinctRoots = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i + 1, path: `/mnt/d${i}/media`, freeSpace: 1e12, accessible: true }));

// ── projectDisks ─────────────────────────────────────────────────────────────

test("projectDisks keeps at most MAX_DISK_ENTRIES of 100k distinct disks", () => {
  const disks = S.projectDisks(distinctDisks(BIG));
  assert.equal(disks.length, S.MAX_DISK_ENTRIES);
});

test("projectDisks reads a bounded prefix of a list of 100k duplicates", () => {
  const { list, reads } = counted(Array.from({ length: BIG }, () => ({ path: "/same", freeSpace: 1 })));
  assert.equal(S.projectDisks(list).length, 1);
  assert.ok(reads() <= S.MAX_DISK_ENTRIES * S.PROJECTION_SCAN_FACTOR, `read ${reads()} entries`);
});

test("projectDisks dedupes through a Set: a repeated path keeps its first entry, no scan of the kept list", () => {
  const disks = S.projectDisks([{ path: "/b", freeSpace: 1 }, { path: "/a", freeSpace: 2 }, { path: "/b", freeSpace: 3 }, { path: "/a/", freeSpace: 4 }]);
  assert.deepEqual(disks.map((d) => [d.path, d.freeSpace]), [["/a", 2], ["/a/", 4], ["/b", 1]]);
  const raw = distinctDisks(S.MAX_DISK_ENTRIES);
  assert.ok(searchVisits(() => S.projectDisks(raw)) <= raw.length);
});

// ── projectRootFolders ───────────────────────────────────────────────────────

test("projectRootFolders keeps at most MAX_ROOT_FOLDERS of 100k roots, and reads a bounded prefix", () => {
  const { list, reads } = counted(distinctRoots(BIG));
  assert.equal(S.projectRootFolders(list, []).length, S.MAX_ROOT_FOLDERS);
  assert.ok(reads() <= S.MAX_ROOT_FOLDERS * S.PROJECTION_SCAN_FACTOR, `read ${reads()} entries`);
  const junk = counted(Array.from({ length: BIG }, () => ({ id: "x", path: "/junk" })));
  assert.equal(S.projectRootFolders(junk.list, []).length, 0);
  assert.ok(junk.reads() <= S.MAX_ROOT_FOLDERS * S.PROJECTION_SCAN_FACTOR, `read ${junk.reads()} junk entries`);
});

test("projectRootFolders reads a bounded prefix of a root's unmapped folders, and still counts them all", () => {
  const { list, reads } = counted(Array.from({ length: BIG }, () => ({ path: "/no/name" })));
  const [root] = S.projectRootFolders([{ id: 1, path: "/movies", unmappedFolders: list }]);
  assert.equal(root.unmappedFolders.length, 0);
  assert.equal(root.unmappedCount, BIG);
  assert.ok(reads() <= S.MAX_UNMAPPED * S.PROJECTION_SCAN_FACTOR, `read ${reads()} unmapped entries`);
});

test("projectRootFolders' roots × disks matching is bounded by the two caps", () => {
  const disks = S.projectDisks(distinctDisks(BIG));
  const { list, reads } = counted(disks);
  const roots = S.projectRootFolders(distinctRoots(BIG), list);
  assert.equal(roots.length, S.MAX_ROOT_FOLDERS);
  // diskFor walks every disk once per root that sends no totalSpace (neither arr does).
  assert.ok(reads() <= S.MAX_ROOT_FOLDERS * S.MAX_DISK_ENTRIES, `read ${reads()} disk entries`);
  // The monitor's readDisks runs over the same two bounded lists.
  const monitored = counted(disks);
  assert.ok(readDisks(roots, monitored.list).length > 0);
  assert.ok(monitored.reads() <= 2 * S.MAX_ROOT_FOLDERS * S.MAX_DISK_ENTRIES, `read ${monitored.reads()} disk entries`);
});

/** How many times String.prototype.replace ran while `fn` ran — once per comparablePath. */
function replaceCalls(fn: () => void): number {
  const proto = String.prototype as unknown as { replace: (...args: unknown[]) => string };
  const original = proto.replace;
  let calls = 0;
  proto.replace = function (this: string, ...args: unknown[]) {
    calls++;
    return original.apply(this, args);
  };
  try {
    fn();
  } finally {
    proto.replace = original;
  }
  return calls;
}

test("projectRootFolders makes each disk's path comparable once, not once per root", () => {
  const disks = S.projectDisks(distinctDisks(BIG));
  const { list, reads } = counted(disks);
  const raw = distinctRoots(S.MAX_ROOT_FOLDERS);
  let roots: S.ArrRootFolder[] = [];
  const calls = replaceCalls(() => {
    roots = S.projectRootFolders(raw, list);
  });
  assert.equal(roots.length, S.MAX_ROOT_FOLDERS);
  assert.ok(roots.every((r) => r.totalSpace === 2e12), "every root still sized from its disk");
  assert.ok(reads() <= 2 * S.MAX_DISK_ENTRIES, `read ${reads()} disk entries`);
  assert.ok(calls <= S.MAX_ROOT_FOLDERS + S.MAX_DISK_ENTRIES, `${calls} comparablePath calls`);
});

test("the monitor's readDisks reuses one comparable disk list for every root", () => {
  const disks = S.projectDisks(distinctDisks(BIG));
  const roots = S.projectRootFolders(distinctRoots(BIG), disks);
  // One root in three on a mount /diskspace doesn't list, so rootDisk refuses it and readDisks asks diskFor too.
  const mixed = roots.map((r, i) => (i % 3 === 0 ? { ...r, freeSpace: 1 } : r));
  let readings: ReturnType<typeof readDisks> = [];
  const calls = replaceCalls(() => {
    readings = readDisks(mixed, disks);
  });
  assert.ok(readings.length > 0);
  assert.ok(calls <= 2 * S.MAX_ROOT_FOLDERS + S.MAX_DISK_ENTRIES, `${calls} comparablePath calls`);
});

test("a remembered comparable disk list is never matched stale after the list changes", () => {
  const disks: S.ArrDisk[] = [{ path: "/", label: null, freeSpace: 1, totalSpace: 2 }];
  assert.equal(S.diskFor("/mnt/media/movies", disks)?.path, "/");
  disks.push({ path: "/mnt/media", label: null, freeSpace: 1, totalSpace: 2 });
  assert.equal(S.diskFor("/mnt/media/movies", disks)?.path, "/mnt/media", "an added disk is seen");
  disks[1] = { path: "/mnt/other", label: null, freeSpace: 1, totalSpace: 2 };
  assert.equal(S.diskFor("/mnt/media/movies", disks)?.path, "/", "a replaced disk is seen");
  disks[1].path = "/mnt/media/";
  assert.equal(S.diskFor("/mnt/media/movies", disks)?.path, "/mnt/media/", "a disk whose path changed in place is seen");
  // A path ending in hundreds of separators still compares as its folder.
  assert.equal(S.diskFor(`/mnt/media/movies${"/".repeat(990)}`, [{ path: `/mnt/media${"\\".repeat(990)}`, label: null, freeSpace: 1, totalSpace: 2 }])?.path.length, 1000);
  assert.equal(S.diskFor("/x", [{ path: "///", label: null, freeSpace: 1, totalSpace: 2 }])?.path, "///");
});

test("projectRootFolders keeps normal lists whole and sizes them from their disk", () => {
  const disks = S.projectDisks([{ path: "/mnt/a", freeSpace: 5e11, totalSpace: 1e12 }, { path: "/", freeSpace: 1e10, totalSpace: 1e11 }]);
  const roots = S.projectRootFolders([{ id: 2, path: "/mnt/a/tv", freeSpace: 5e11 }, { id: 1, path: "/mnt/a/movies", freeSpace: 5e11 }], disks);
  assert.deepEqual(roots.map((r) => [r.id, r.path, r.totalSpace]), [[1, "/mnt/a/movies", 1e12], [2, "/mnt/a/tv", 1e12]]);
});

// ── projectTasks / projectTags ───────────────────────────────────────────────

test("projectTasks keeps at most MAX_TASKS of 100k distinct tasks, and reads a bounded prefix of duplicates", () => {
  assert.equal(S.projectTasks(Array.from({ length: BIG }, (_, i) => ({ taskName: `Task${i}` }))).length, S.MAX_TASKS);
  const { list, reads } = counted(Array.from({ length: BIG }, () => ({ taskName: "RssSync" })));
  assert.equal(S.projectTasks(list).length, 1);
  assert.ok(reads() <= S.MAX_TASKS * S.PROJECTION_SCAN_FACTOR, `read ${reads()} entries`);
});

test("projectTasks dedupes through a Set: first entry wins, no scan of the kept list", () => {
  const tasks = S.projectTasks([{ taskName: "RssSync", name: "RSS Sync" }, { taskName: "Backup", name: "Backup" }, { taskName: "RssSync", name: "Again" }]);
  assert.deepEqual(tasks.map((t) => [t.taskName, t.name]), [["Backup", "Backup"], ["RssSync", "RSS Sync"]]);
  const raw = Array.from({ length: S.MAX_TASKS }, (_, i) => ({ taskName: `Task${i}` }));
  assert.ok(searchVisits(() => S.projectTasks(raw)) <= raw.length);
});

test("projectTags keeps at most MAX_TAG_ENTRIES, reads a bounded prefix, and dedupes through a Set", () => {
  assert.equal(S.projectTags(Array.from({ length: BIG }, (_, i) => ({ id: i + 1, label: `t${i}` }))).length, S.MAX_TAG_ENTRIES);
  const { list, reads } = counted(Array.from({ length: BIG }, () => ({ id: 7, label: "dup" })));
  assert.deepEqual(S.projectTags(list), [{ id: 7, label: "dup" }]);
  assert.ok(reads() <= S.MAX_TAG_ENTRIES * S.PROJECTION_SCAN_FACTOR, `read ${reads()} entries`);
  assert.deepEqual(S.projectTags([{ id: 2, label: "b" }, { id: 1, label: "a" }, { id: 2, label: "again" }]), [{ id: 2, label: "b" }, { id: 1, label: "a" }]);
  const raw = Array.from({ length: S.MAX_TAG_ENTRIES }, (_, i) => ({ id: i + 1, label: `t${i}` }));
  assert.ok(searchVisits(() => S.projectTags(raw)) <= raw.length);
});

// ── the title manager's catalog ──────────────────────────────────────────────

test("projectChoices keeps at most MAX_CHOICES of 100k distinct tags or profiles", () => {
  assert.equal(T.projectChoices(Array.from({ length: BIG }, (_, i) => ({ id: i + 1, label: `t${i}` })), "label").length, T.MAX_CHOICES);
  assert.equal(T.projectChoices(Array.from({ length: BIG }, (_, i) => ({ id: i + 1, name: `p${i}` }))).length, T.MAX_CHOICES);
});

test("projectChoices reads a bounded prefix of a list of 100k duplicates", () => {
  const { list, reads } = counted(Array.from({ length: BIG }, () => ({ id: 3, name: "HD" })));
  assert.deepEqual(T.projectChoices(list), [{ id: 3, name: "HD" }]);
  assert.ok(reads() <= T.MAX_CHOICES * T.PROJECTION_SCAN_FACTOR, `read ${reads()} entries`);
});

test("projectChoices dedupes through a Set: order kept, first-seen name wins, no scan of the kept list", () => {
  assert.deepEqual(
    T.projectChoices([{ id: 4, name: "4K" }, { id: 1, name: "Any" }, { id: 4, name: "renamed" }, { id: 2 }, { id: 2, name: "HD" }]),
    [{ id: 4, name: "4K" }, { id: 1, name: "Any" }, { id: 2, name: "HD" }],
  );
  const raw = Array.from({ length: T.MAX_CHOICES }, (_, i) => ({ id: i + 1, name: `p${i}` }));
  assert.ok(searchVisits(() => T.projectChoices(raw)) <= raw.length);
});

test("projectRootFolderChoices keeps at most MAX_ROOT_FOLDER_CHOICES, reads a bounded prefix, and dedupes through a Set", () => {
  assert.equal(T.projectRootFolderChoices(distinctRoots(BIG)).length, T.MAX_ROOT_FOLDER_CHOICES);
  const { list, reads } = counted(Array.from({ length: BIG }, () => ({ path: "/movies", freeSpace: 1 })));
  assert.equal(T.projectRootFolderChoices(list).length, 1);
  assert.ok(reads() <= T.MAX_ROOT_FOLDER_CHOICES * T.PROJECTION_SCAN_FACTOR, `read ${reads()} entries`);
  assert.deepEqual(
    T.projectRootFolderChoices([{ path: "/tv", freeSpace: 1 }, { path: "/movies", accessible: false }, { path: "/tv", freeSpace: 9 }]),
    [{ path: "/tv", freeSpace: 1, accessible: true }, { path: "/movies", freeSpace: null, accessible: false }],
  );
  const raw = distinctRoots(T.MAX_ROOT_FOLDER_CHOICES);
  assert.ok(searchVisits(() => T.projectRootFolderChoices(raw)) <= raw.length);
});

// ── the Download Queue fold ──────────────────────────────────────────────────

const queueRecord = (over: Record<string, unknown>) => ({ id: 1, movieId: 1, movie: { title: "M" }, ...over });

test("a queue record with 100k distinct messages keeps MAX_MESSAGES, and stops reading once it has them", () => {
  const { list, reads } = counted(Array.from({ length: BIG }, (_, i) => `message ${i}`));
  const [row] = Q.foldQueueRecords("radarr", "", [queueRecord({ statusMessages: [{ title: "file.mkv", messages: list }] })]);
  assert.equal(Q.MAX_MESSAGES, 6);
  assert.deepEqual(row.messages, Array.from({ length: Q.MAX_MESSAGES }, (_, i) => `message ${i}`));
  assert.ok(reads() <= Q.MAX_MESSAGES, `read ${reads()} messages`);
});

test("a queue record's messages and statusMessages are each read a bounded prefix deep", () => {
  const scan = Q.MAX_MESSAGES * Q.PROJECTION_SCAN_FACTOR;
  const dupes = counted(Array.from({ length: BIG }, () => "Not an upgrade"));
  const entries = counted(Array.from({ length: BIG }, () => ({ title: "same", messages: [] })));
  const [row] = Q.foldQueueRecords("radarr", "", [queueRecord({ statusMessages: [{ messages: dupes.list }] })]);
  assert.deepEqual(row.messages, ["Not an upgrade"]);
  assert.ok(dupes.reads() <= scan, `read ${dupes.reads()} messages`);
  const [other] = Q.foldQueueRecords("radarr", "", [queueRecord({ id: 2, statusMessages: entries.list })]);
  assert.deepEqual(other.messages, ["same"]);
  assert.ok(entries.reads() <= scan, `read ${entries.reads()} status messages`);
});

test("queue messages dedupe through a Set: first-seen order, trimmed and truncated before comparing", () => {
  const long = "x".repeat(400);
  const [row] = Q.foldQueueRecords("radarr", "", [queueRecord({
    errorMessage: " a ",
    statusMessages: [{ title: "T1", messages: ["b", "a", "  b  ", "", long, `${"x".repeat(300)}y`] }, { title: "T2", messages: [] }, null, { title: "c" }],
  })]);
  assert.deepEqual(row.messages, ["a", "b", "x".repeat(300), "T2", "c"]);
  const raw = [queueRecord({ statusMessages: [{ messages: Array.from({ length: Q.MAX_MESSAGES * Q.PROJECTION_SCAN_FACTOR }, (_, i) => `m${i % 3}`) }] })];
  assert.equal(searchVisits(() => Q.foldQueueRecords("radarr", "", raw)), 0);
});

test("a queue record's languages and custom formats keep MAX_LABELS, read a bounded prefix, and dedupe through a Set", () => {
  const scan = Q.MAX_LABELS * Q.PROJECTION_SCAN_FACTOR;
  const languages = counted(Array.from({ length: BIG }, () => ({ name: "English" })));
  const formats = counted(Array.from({ length: BIG }, (_, i) => ({ name: `CF${i}` })));
  const [row] = Q.foldQueueRecords("radarr", "", [queueRecord({ languages: languages.list, customFormats: formats.list })]);
  assert.deepEqual(row.languages, ["English"]);
  assert.ok(languages.reads() <= scan, `read ${languages.reads()} languages`);
  assert.equal(row.customFormats.length, Q.MAX_LABELS);
  assert.ok(formats.reads() <= Q.MAX_LABELS, `read ${formats.reads()} custom formats`);
  const raw = [queueRecord({ customFormats: Array.from({ length: scan }, (_, i) => ({ name: ` CF${i % 7}` })) })];
  assert.deepEqual(Q.foldQueueRecords("radarr", "", raw)[0].customFormats, Array.from({ length: 7 }, (_, i) => `CF${i}`));
  assert.equal(searchVisits(() => Q.foldQueueRecords("radarr", "", raw)), 0);
});

test("a Sonarr pack folds its episodes through a Set: duplicates dropped, no scan of the folded list", () => {
  const n = 2_000;
  const records = Array.from({ length: n }, (_, i) => ({
    id: i + 1, downloadId: "PACK", seriesId: 9, series: { title: "S" },
    episode: { seasonNumber: 1 + (i % 2), episodeNumber: Math.floor(i / 2) % 500 },
  }));
  let rows: Q.QueueItem[] = [];
  const visits = searchVisits(() => {
    rows = Q.foldQueueRecords("sonarr", "", records);
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ids.length, n);
  assert.equal(rows[0].episodes.length, 1_000, "every (season, episode) once");
  assert.deepEqual(rows[0].episodes.slice(0, 2), [{ seasonNumber: 1, episodeNumber: 0 }, { seasonNumber: 1, episodeNumber: 1 }]);
  assert.deepEqual(rows[0].episodes.at(-1), { seasonNumber: 2, episodeNumber: 499 });
  assert.ok(visits <= n, `searched ${visits} elements folding ${n} records`);
});

// ── the Calendar's projections ───────────────────────────────────────────────

const CAL_START = Date.parse("2026-10-19T00:00:00Z");
const CAL_END = CAL_START + 14 * 86_400_000;
const CAL_NOW = Date.parse("2026-10-25T00:00:00Z");
const IN_WINDOW = "2026-10-20T00:00:00Z";
// The review's hostile answer: 130k minimal entries is ~8 MB, well under
// arrFetch's 50 MB, and a spread push of it throws RangeError.
const HOSTILE = 130_000;
const calScan = C.MAX_CALENDAR_ENTRIES * Q.PROJECTION_SCAN_FACTOR;

test("radarrCalendarEntries keeps at most MAX_CALENDAR_ENTRIES of 130k movies, in order, and reads a bounded prefix", () => {
  const { list, reads } = counted(Array.from({ length: HOSTILE }, (_, i) => ({ id: i + 1, digitalRelease: IN_WINDOW })));
  const entries = C.radarrCalendarEntries("", list, CAL_START, CAL_END, CAL_NOW);
  assert.equal(entries.length, C.MAX_CALENDAR_ENTRIES);
  assert.deepEqual([entries[0].arrId, entries.at(-1)?.arrId], [1, C.MAX_CALENDAR_ENTRIES]);
  assert.ok(reads() <= calScan, `read ${reads()} movies`);
  // A movie with all three dates in the window counts three entries toward the cap.
  const three = C.radarrCalendarEntries("", Array.from({ length: HOSTILE }, (_, i) => ({ id: i + 1, inCinemas: IN_WINDOW, physicalRelease: IN_WINDOW, digitalRelease: IN_WINDOW })), CAL_START, CAL_END, CAL_NOW);
  assert.equal(three.length, C.MAX_CALENDAR_ENTRIES);
  // Junk and out-of-window movies never reach the cap: the scan stops all the same.
  const junk = counted(Array.from({ length: 2 * calScan }, (_, i) => ({ id: i + 1, digitalRelease: "2020-01-01T00:00:00Z" })));
  assert.deepEqual(C.radarrCalendarEntries("", junk.list, CAL_START, CAL_END, CAL_NOW), []);
  assert.ok(junk.reads() <= calScan, `read ${junk.reads()} out-of-window movies`);
});

test("sonarrCalendarEntries keeps at most MAX_CALENDAR_ENTRIES of the review's 130k episodes, and reads a bounded prefix of junk", () => {
  const entries = C.sonarrCalendarEntries("", Array.from({ length: HOSTILE }, (_, i) => ({ id: i + 1, seriesId: 1, airDateUtc: IN_WINDOW })), CAL_NOW);
  assert.equal(entries.length, C.MAX_CALENDAR_ENTRIES);
  assert.deepEqual([entries[0].episodeId, entries.at(-1)?.episodeId], [1, C.MAX_CALENDAR_ENTRIES]);
  const junk = counted(Array.from({ length: 2 * calScan }, (_, i) => ({ id: i + 1, seriesId: "x" })));
  assert.deepEqual(C.sonarrCalendarEntries("", junk.list, CAL_NOW), []);
  assert.ok(junk.reads() <= calScan, `read ${junk.reads()} junk episodes`);
});

test("the calendar projections keep an honest window whole", () => {
  const movies = C.radarrCalendarEntries("", [{ id: 2, title: "B", physicalRelease: IN_WINDOW, digitalRelease: "2026-12-01T00:00:00Z" }, { id: 1, title: "A", inCinemas: IN_WINDOW }], CAL_START, CAL_END, CAL_NOW);
  assert.deepEqual(movies.map((e) => e.key), ["radarr::2:physical", "radarr::1:cinema"]);
  const episodes = C.sonarrCalendarEntries("4k", [{ id: 7, seriesId: 3, airDateUtc: IN_WINDOW, seasonNumber: 1 }, { id: 8, seriesId: 3, airDateUtc: IN_WINDOW, seasonNumber: 1 }], CAL_NOW);
  assert.deepEqual(episodes.map((e) => e.key), ["sonarr:4k:7:episode", "sonarr:4k:8:episode"]);
});

// ── the Missing page's projections ───────────────────────────────────────────

const missingScan = M.MAX_MISSING_ITEMS * Q.PROJECTION_SCAN_FACTOR;
const NOW = Date.parse("2026-10-20T00:00:00Z");

test("missingMovieList keeps at most MAX_MISSING_ITEMS of the review's 130k movies, in order, and reads a bounded prefix of junk", () => {
  const items = M.missingMovieList(Array.from({ length: HOSTILE }, (_, i) => ({ id: i + 1, digitalRelease: "2020-01-01T00:00:00Z" })), "", NOW);
  assert.equal(items.length, M.MAX_MISSING_ITEMS);
  assert.deepEqual([items[0].arrId, items.at(-1)?.arrId], [1, M.MAX_MISSING_ITEMS]);
  // Movies that have their file are never listed: the scan stops all the same.
  const junk = counted(Array.from({ length: 2 * missingScan }, (_, i) => ({ id: i + 1, hasFile: true, digitalRelease: "2020-01-01T00:00:00Z" })));
  assert.deepEqual(M.missingMovieList(junk.list, "", NOW), []);
  assert.ok(junk.reads() <= missingScan, `read ${junk.reads()} movies`);
  assert.deepEqual(M.missingMovieList({ records: [] }, "", NOW), []);
});

test("missingSeriesList keeps at most MAX_MISSING_ITEMS of 130k series, in order, and reads a bounded prefix of complete ones", () => {
  const items = M.missingSeriesList(Array.from({ length: HOSTILE }, (_, i) => ({ id: i + 1, statistics: { episodeCount: 2, episodeFileCount: 1 } })), "");
  assert.equal(items.length, M.MAX_MISSING_ITEMS);
  assert.deepEqual([items[0].arrId, items.at(-1)?.arrId], [1, M.MAX_MISSING_ITEMS]);
  const complete = counted(Array.from({ length: 2 * missingScan }, (_, i) => ({ id: i + 1, statistics: { episodeCount: 1, episodeFileCount: 1 } })));
  assert.deepEqual(M.missingSeriesList(complete.list, ""), []);
  assert.ok(complete.reads() <= missingScan, `read ${complete.reads()} series`);
});

test("the missing list builders keep an honest listing whole, judged row by row", () => {
  const movies = M.missingMovieList([{ id: 1, hasFile: true, digitalRelease: "2020-01-01T00:00:00Z" }, null, "x", { id: 2, digitalRelease: "2020-01-01T00:00:00Z" }, { id: 3, inCinemas: "2020-01-01T00:00:00Z" }], "hd", NOW);
  assert.deepEqual(movies.map((m) => [m.instance, m.arrId]), [["hd", 2]]);
  const series = M.missingSeriesList([{ id: 4, statistics: { episodeCount: 3, episodeFileCount: 3 } }, { id: 5, statistics: { episodeCount: 3, episodeFileCount: 1 } }], "");
  assert.deepEqual(series.map((s) => [s.arrId, s.missing]), [[5, 2]]);
});

test("planSeriesSearch takes a 200k-episode season's missing ids one by one, never a spread push", () => {
  const n = 200_000;
  const rows = [
    { id: n + 1, seasonNumber: 1, episodeNumber: 0, hasFile: true, monitored: true, airDateUtc: "2020-01-01T00:00:00Z" },
    ...Array.from({ length: n }, (_, i) => ({ id: i + 1, seasonNumber: 1, episodeNumber: i + 1, hasFile: false, monitored: true, airDateUtc: "2020-01-01T00:00:00Z" })),
  ];
  const plan = M.planSeriesSearch(rows, NOW);
  assert.deepEqual(plan.seasons, []);
  assert.equal(plan.episodeIds.length, n);
  assert.deepEqual([plan.episodeIds[0], plan.episodeIds.at(-1)], [1, n]);
});

// ── the per-instance merges, end to end ──────────────────────────────────────

const jsonOf = (rows: unknown[]) => () => rows;
const emptyQueue = () => ({ page: 1, pageSize: 250, totalRecords: 0, records: [] });

test("loadCalendar survives the review's 130k-episode Sonarr answer: capped, no RangeError, the honest instance's entries kept", async () => {
  answers.clear();
  answers.set(`${SONARR}/api/v3/calendar`, jsonOf(Array.from({ length: HOSTILE }, (_, i) => ({ id: i + 1, seriesId: 1, airDateUtc: IN_WINDOW }))));
  answers.set(`${RADARR}/api/v3/calendar`, jsonOf([{ id: 1, tmdbId: 5, title: "Honest", digitalRelease: IN_WINDOW }]));
  answers.set(`${RADARR}/api/v3/queue`, emptyQueue);
  answers.set(`${SONARR}/api/v3/queue`, emptyQueue);
  const report = await calendarData.loadCalendar(new Date(CAL_START), new Date(CAL_END), false, new Date(CAL_NOW));
  assert.deepEqual(report.errors, []);
  assert.equal(report.entries.filter((e) => e.service === "sonarr").length, C.MAX_CALENDAR_ENTRIES);
  assert.deepEqual(report.entries.filter((e) => e.service === "radarr").map((e) => e.title), ["Honest"]);
});

test("loadMissingMovies and loadMissingSeries survive a 130k-title listing: capped per instance, no RangeError", async () => {
  answers.clear();
  answers.set(`${RADARR}/api/v3/movie`, jsonOf(Array.from({ length: HOSTILE }, (_, i) => ({ id: i + 1, digitalRelease: "2020-01-01T00:00:00Z" }))));
  answers.set(`${SONARR}/api/v3/series`, jsonOf(Array.from({ length: HOSTILE }, (_, i) => ({ id: i + 1, statistics: { episodeCount: 2, episodeFileCount: 1 } }))));
  const movies = await missingData.loadMissingMovies(new Date(NOW));
  assert.deepEqual(movies.errors, []);
  assert.equal(movies.items.length, M.MAX_MISSING_ITEMS);
  const series = await missingData.loadMissingSeries();
  assert.deepEqual(series.errors, []);
  assert.equal(series.items.length, M.MAX_MISSING_ITEMS);
});

test("the Calendar and Missing modules append one by one: no spread push anywhere in them", () => {
  // The caps keep each per-instance list far below where a spread throws, so
  // only the source can show a merge (or a planner) went back to one.
  for (const file of ["arr-calendar.ts", "arr-calendar-data.ts", "arr-missing.ts", "arr-missing-data.ts"]) {
    const src = readFileSync(new URL(`../src/lib/${file}`, import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(src, /\.push\(\s*\.\.\./, `${file} spread-pushes a list`);
  }
});

// ── the paged readers ────────────────────────────────────────────────────────

// Every page holds this many records, and totalRecords says there are that
// many: far more than a page, and past where a spread push throws RangeError.
// A record is `page × 1e6 + its index on the page`, so what was kept from each
// page can be read back.
const HOSTILE_PAGE = 200_000;
function hostilePage(url: URL) {
  const page = Number(url.searchParams.get("page"));
  const pageSize = Number(url.searchParams.get("pageSize"));
  served.push({ path: url.pathname, page, pageSize });
  return { page, pageSize, totalRecords: HOSTILE_PAGE, records: Array.from({ length: HOSTILE_PAGE }, (_, i) => page * 1_000_000 + i) };
}

function assertPagedRead(records: unknown[], pageSize: number, maxPages: number): void {
  assert.ok(served.length > 0 && served.length <= maxPages, `read ${served.length} pages`);
  assert.ok(served.every((s) => s.pageSize === pageSize), "every page asked for the reader's own page size");
  assert.ok(records.length <= maxPages * pageSize, `kept ${records.length} records in all`);
  assert.equal(records.length, served.length * pageSize, "each page read contributed exactly a page's worth");
  const perPage = new Map<number, number>();
  for (const r of records) {
    const n = r as number;
    assert.ok(n % 1_000_000 < pageSize, `kept record ${n % 1_000_000} of page ${Math.floor(n / 1_000_000)}: only a page's first ${pageSize}`);
    perPage.set(Math.floor(n / 1_000_000), (perPage.get(Math.floor(n / 1_000_000)) ?? 0) + 1);
  }
  for (const [page, kept] of perPage) assert.ok(kept <= pageSize, `kept ${kept} records of page ${page}`);
}

test("readQueuePages keeps at most PAGE_SIZE of each 200k-record page, and at most MAX_PAGES × PAGE_SIZE in all", async () => {
  answers.clear();
  answers.set(`${RADARR}/api/v3/queue`, hostilePage);
  served = [];
  const records = await queueData.readQueuePages("radarr", "");
  assertPagedRead(records, queueData.PAGE_SIZE, queueData.MAX_PAGES);
  assert.equal(served.length, queueData.MAX_PAGES, "the page ceiling, not the list's end, stopped the read");
});

test("the calendar's queue read keeps at most QUEUE_PAGE_SIZE of each 200k-record page, and at most MAX_QUEUE_PAGES × QUEUE_PAGE_SIZE in all", async () => {
  answers.clear();
  answers.set(`${SONARR}/api/v3/queue`, hostilePage);
  served = [];
  const records = await calendarData.readQueue({ url: SONARR, apiKey: "sonarr-key" });
  assertPagedRead(records, calendarData.QUEUE_PAGE_SIZE, calendarData.MAX_QUEUE_PAGES);
  assert.equal(served.length, calendarData.MAX_QUEUE_PAGES);
});

test("readCutoffPages keeps at most CUTOFF_PAGE_SIZE of each 200k-record page, at most CUTOFF_MAX_PAGES × CUTOFF_PAGE_SIZE in all, and says it was truncated", async () => {
  answers.clear();
  answers.set(`${RADARR}/api/v3/wanted/cutoff`, hostilePage);
  served = [];
  const listing = await missingData.readCutoffPages({ url: RADARR, apiKey: "radarr-key" }, "radarr");
  assertPagedRead(listing.records, missingData.CUTOFF_PAGE_SIZE, missingData.CUTOFF_MAX_PAGES);
  assert.equal(served.length, missingData.CUTOFF_MAX_PAGES);
  assert.deepEqual([listing.total, listing.truncated], [HOSTILE_PAGE, true]);
});
