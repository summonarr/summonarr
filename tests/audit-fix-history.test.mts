// Audit fixes for Admin → Download History (C036–C039, C085):
//   - a grab's state on a list that can't hold its newer records is UNKNOWN,
//     never "neither" (grabStateKnown + the History page's `filtered` prop);
//   - a blocklist entry deep in the list that shifted by a page since the admin
//     viewed it is found on the viewed page's neighbours, not called gone;
//   - the page's wiring: Mark failed pins the view, Clear/Remove wait for the
//     ClearBlocklist command, a clear with no command id re-reads, and a row's
//     Mark failed error is cleared when a retry starts.
//
// Harness: removeFromBlocklist is called directly against a scripted Radarr
// behind a stubbed fetch + DNS and an in-memory Setting table (the
// tests/arr-fix-history.test.mts pattern, minus the route and session layer).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";
import { readFileSync } from "node:fs";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
process.env.NEXTAUTH_SECRET = "audit-fix-history-test-secret-0123456789abcd";
(process.env as Record<string, string | undefined>).NODE_ENV = "test";

const fakeLookup = async () => [{ address: "10.0.0.250", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) throw new Error("could not stub dns.lookup");

console.warn = () => {};
console.error = () => {};

const RADARR = "http://10.0.0.5:7878";
type Call = { method: string; path: string; query: URLSearchParams; body: unknown };
let calls: Call[] = [];
let responder: (c: Call) => Response | undefined = () => undefined;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  let body: unknown;
  if (typeof init?.body === "string" && init.body !== "") {
    try { body = JSON.parse(init.body); } catch { body = init.body; }
  }
  const call = { method, path: url.pathname, query: url.searchParams, body };
  calls.push(call);
  const res = responder(call);
  if (res) return res;
  throw new Error(`unexpected ${method} ${url}`);
}) as unknown as typeof fetch;

const { prisma } = await import("../src/lib/prisma.ts");
const { shadowPrismaModel } = await import("./_helpers.mts");
const settings = new Map<string, string>();
shadowPrismaModel(prisma, "setting", {
  findMany: async (args?: { where?: { key?: { in?: string[] } } }) => {
    const keys = args?.where?.key?.in;
    return [...settings.entries()].filter(([k]) => !keys || keys.includes(k)).map(([key, value]) => ({ key, value }));
  },
  findUnique: async (args: { where: { key: string } }) => {
    const v = settings.get(args.where.key);
    return v === undefined ? null : { key: args.where.key, value: v };
  },
  upsert: async () => ({}),
});

const { BlocklistGoneError, removeFromBlocklist } = await import("../src/lib/arr-history-data.ts");
const { grabStateKnown, grabStateOf, groupHistoryEvents, projectHistoryRecord } = await import("../src/lib/arr-history.ts");
type ArrHistoryEvent = import("../src/lib/arr-history.ts").ArrHistoryEvent;

beforeEach(() => {
  calls = [];
  responder = () => undefined;
  settings.clear();
  settings.set("radarrUrl", RADARR);
  settings.set("radarrApiKey", "radarr-key");
});

// ── C039: a grab's state on a list that can't hold its newer records ─────────

const ep = (id: number, kind: string, downloadId: string | null): ArrHistoryEvent => {
  const e = projectHistoryRecord("sonarr", "", {
    id, seriesId: 21, eventType: kind, downloadId, date: "2026-10-01T10:00:00Z", sourceTitle: "Show.S02.1080p",
    episode: { seasonNumber: 2, episodeNumber: 1, title: "Ep 1" },
  });
  assert.ok(e);
  return e;
};

test("a grab's state is known on a complete list, and on a partial one only by what it found", () => {
  const full = [ep(13, "downloadFolderImported", "PACK"), ep(10, "grabbed", "PACK")];
  const grabsOnly = full.filter((e) => e.kind === "grabbed");
  const failedToo = [ep(14, "downloadFailed", "PACK"), ...grabsOnly];
  const stateIn = (events: ArrHistoryEvent[]) => grabStateOf(groupHistoryEvents(events).find((r) => r.lead.id === 10)!, events);

  // A grabs-only (filtered) list found nothing — and that proves nothing.
  assert.equal(grabStateKnown(stateIn(grabsOnly), { complete: false }), false, "a filtered list can't say 'neither'");
  // The same nothing on a complete list IS the answer.
  assert.equal(grabStateKnown(stateIn(grabsOnly), { complete: true }), true);
  // A record found is proof on any list.
  assert.equal(grabStateKnown(stateIn(full), { complete: false }), true, "an import on the page is proof");
  assert.equal(grabStateKnown(stateIn(failedToo), { complete: false }), true, "a failure on the page is proof");
});

test("the list believes a grab's state only where it could hold the newer records, and the page says when it is filtered", () => {
  const list = readFileSync(new URL("../src/components/admin/arr-history-list.tsx", import.meta.url), "utf8");
  // Complete = not filtered by kind AND no page before this one.
  assert.match(list, /const complete = !filtered && !hasPrevious;/);
  assert.match(list, /grabStateKnown\(state, \{ complete \}\)/);
  // The confirm shows the caveat when the state is unknown, never silence.
  assert.match(list, /!known && <span[^>]*>\{t\("adminArr\.history\.stateUnknown"\)\}/);
  // The title manager's tab passes no filter — the prop defaults off.
  assert.match(list, /filtered = false,/);

  const page = readFileSync(new URL("../src/components/admin/arr-download-history.tsx", import.meta.url), "utf8");
  // By the kind the history on screen was READ with, not the one being loaded.
  assert.match(page, /filtered=\{historyKind !== "all"\}/);
  assert.match(page, /setHistory\(res\.data\);\s*setHistoryKind\(kind\);/);
});

// ── C037: Mark failed pins the view; Clear/Remove wait for the clear ─────────

const page = () => readFileSync(new URL("../src/components/admin/arr-download-history.tsx", import.meta.url), "utf8");
const fnBody = (src: string, name: string) => {
  const start = src.indexOf(`async function ${name}(`);
  assert.ok(start >= 0, name);
  const end = src.indexOf("\n  }\n", start);
  return src.slice(start, end);
};

test("a Mark failed in flight holds the page's busy state from before its POST until it settles", () => {
  const body = fnBody(page(), "markFailed");
  const set = body.indexOf('setBusy("mark")');
  assert.ok(set >= 0, "Mark failed marks the page busy");
  assert.ok(set < body.indexOf("fetch("), "before the POST goes out");
  assert.match(body, /finally \{\s*setBusy\(null\);\s*\}/, "and releases it whatever the answer");
  const src = page();
  assert.match(src, /useState<"remove" \| "clear" \| "mark" \| null>/);
  // The kind chips and both pagers hold still too (the tab and instance sit in the fieldset).
  assert.match(src, /aria-pressed=\{kind === k\}\s*disabled=\{busy !== null\}/);
  assert.equal([...src.matchAll(/<Pager [^>]*disabled=\{loading \|\| busy !== null\}/g)].length, 2);
});

test("while Clear blocklist's command is followed, Clear and Remove stay disabled", () => {
  const src = page();
  assert.match(src, /const clearing = isWatchActive\(watches\.clear\);/);
  assert.match(src, /disabled=\{selected\.size === 0 \|\| busy !== null \|\| clearing\} onClick=\{\(\) => void removeSelected\(\)\}/, "Remove selected");
  assert.match(src, /disabled=\{busy !== null \|\| clearing\} onClick=\{\(\) => void clearAll\(\)\}/, "the confirm's Clear");
  assert.match(src, /disabled=\{!blocklist \|\| blocklist\.totalRecords === 0 \|\| busy !== null \|\| clearing\} onClick=\{\(\) => setConfirmClear\(true\)\}/, "Clear");
});

// ── C036: a clear the arr answered with no command id re-reads once ──────────

test("a clear answered with no command id re-reads the list instead of leaving it stale", () => {
  const body = fnBody(page(), "clearAll");
  const noId = body.slice(body.indexOf("} else {", body.indexOf("if (ids.length > 0)")));
  assert.match(noId, /setNotice\(t\("adminArr\.blocklist\.cleared"\)\);\s*void loadRef\.current\(\);/);
});

// ── C038: a row's Mark failed error doesn't outlive a successful retry ────────

test("a Mark failed retry clears the row's earlier error before it runs", () => {
  const list = readFileSync(new URL("../src/components/admin/arr-history-list.tsx", import.meta.url), "utf8");
  const start = list.indexOf("async function mark(");
  const body = list.slice(start, list.indexOf("\n  }\n", start));
  const cleared = body.search(/setErrors\(\(m\) => \{[\s\S]*?delete next\[row\.key\];[\s\S]*?\}\);/);
  assert.ok(cleared >= 0, "the row's error is deleted");
  assert.ok(cleared < body.indexOf("await onMarkFailed("), "before the attempt");
});

// ── C085: an entry shifted by a page past the scan's cap ─────────────────────

/**
 * A blocklist of `total` original entries (ids 1..total, newest first) after
 * `shift` changes at the top: shift > 0 adds that many newer entries (ids
 * total+1…) above them, shift < 0 removes the newest -shift of them.
 */
function shiftedBlocklist(total: number, shift: number) {
  const size = total + shift;
  const idAt = (pos: number) => (shift >= 0 ? (pos <= shift ? total + shift - pos + 1 : pos - shift) : pos - shift);
  return (c: Call): Response | undefined => {
    if (c.method === "DELETE" && c.path === "/api/v3/blocklist/bulk") return new Response("", { status: 200 });
    if (c.method !== "GET" || c.path !== "/api/v3/blocklist") return undefined;
    const p = Number(c.query.get("page"));
    const s = Number(c.query.get("pageSize"));
    const records = [];
    for (let pos = (p - 1) * s + 1; pos <= Math.min(size, p * s); pos++) records.push({ id: idAt(pos), movieId: 11, sourceTitle: `Release.${idAt(pos)}` });
    return json({ page: p, pageSize: s, totalRecords: size, records });
  };
}
const reads = () => calls.filter((c) => c.method === "GET").map((c) => [c.query.get("page"), c.query.get("pageSize")]);
const deletes = () => calls.filter((c) => c.method === "DELETE").map((c) => c.body);
const scan = Array.from({ length: 20 }, (_, i) => [String(i + 1), "1000"]);

test("an entry pushed onto the NEXT page by a new blocklisting, past the 20,000-record scan, is still found", async () => {
  // Page 480 of 50 held 23,951–24,000; one newer entry pushed 24,000 onto page 481.
  responder = shiftedBlocklist(25_000, 1);
  const removed = await removeFromBlocklist("radarr", "", [24_000], { page: 480, pageSize: 50 });
  assert.deepEqual(removed.map((r) => r.id), [24_000]);
  assert.deepEqual(reads(), [["480", "50"], ...scan, ["481", "50"]]);
  assert.deepEqual(deletes(), [{ ids: [24_000] }]);
});

test("an entry pulled onto the PREVIOUS page by a removal, past the scan, is still found", async () => {
  // Page 480 of 50 held 23,951–24,000; one removal above pulled 23,951 onto page 479.
  responder = shiftedBlocklist(25_000, -1);
  const removed = await removeFromBlocklist("radarr", "", [23_951], { page: 480, pageSize: 50 });
  assert.deepEqual(removed.map((r) => r.id), [23_951]);
  assert.deepEqual(reads(), [["480", "50"], ...scan, ["481", "50"], ["479", "50"]]);
  assert.deepEqual(deletes(), [{ ids: [23_951] }]);
});

test("an entry that really is gone is still refused, and neighbours inside the scanned range are never re-read", async () => {
  responder = shiftedBlocklist(25_000, 1);
  // 99,999 is on no page at all: viewed page, the capped scan, its neighbours — then gone.
  await assert.rejects(removeFromBlocklist("radarr", "", [99_999], { page: 480, pageSize: 50 }), BlocklistGoneError);
  assert.deepEqual(reads(), [["480", "50"], ...scan, ["481", "50"], ["479", "50"]]);
  assert.deepEqual(deletes(), []);

  // Viewed page 10 of 50 sits inside the scan: its neighbours were already read fresh.
  calls = [];
  await assert.rejects(removeFromBlocklist("radarr", "", [99_999], { page: 10, pageSize: 50 }), BlocklistGoneError);
  assert.deepEqual(reads(), [["10", "50"], ...scan]);

  // A scan that reached the end of the list read every record: no neighbour reads.
  calls = [];
  responder = shiftedBlocklist(400, 1);
  await assert.rejects(removeFromBlocklist("radarr", "", [99_999], { page: 3, pageSize: 50 }), BlocklistGoneError);
  assert.deepEqual(reads(), [["3", "50"], ["1", "1000"]]);

  // No viewed hint: the capped scan alone decides (the existing 20-page bound).
  calls = [];
  responder = shiftedBlocklist(25_000, 0);
  await assert.rejects(removeFromBlocklist("radarr", "", [24_000]), BlocklistGoneError);
  assert.deepEqual(reads(), scan);
});
