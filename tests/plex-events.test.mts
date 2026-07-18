// Unit tests for the Plex SSE client (src/lib/plex-events.ts) — the module
// that owns the single long-lived /:/eventsource/notifications connection,
// the recently-finalized ledger, and the SSE-driven finalize/live-update
// paths. The two headline pins are CLAUDE.md guardrails 20 and 21:
//
//   Guardrail 20 — the stall anchor tracks playhead MOVEMENT, not advance.
//   applyLiveStateUpdate (the SSE `playing` writer) must refresh
//   progressUpdatedAt whenever the incoming viewOffset DIFFERS from the stored
//   progressMs — forward OR backward (a seek is liveness) — and must NOT
//   refresh it when the offset is identical (a frozen ghost has to age past
//   PLEX_STALL_THRESHOLD_MS so the poller can finalize it). A resume
//   transition (non-playing → playing) refreshes even with an equal offset.
//   Regressing the `!==` comparison to a strict `>` makes the 5s poller
//   stall-finalize live streams whenever SSE wrote progressMs last.
//
//   Guardrail 21 — reanchorActiveSessionsOnBoot() runs at the TOP of
//   bootstrapReconcile, BEFORE any ActiveSession read that feeds the absence
//   finalize. The global prisma call log records order: the very first
//   ActiveSession operation of the process must be the where-less
//   updateMany({ data: { lastSeenAt } }), and it must precede the
//   source:"plex" findMany. The re-anchor is once-guarded per process
//   (play-history memoizes the promise), so this order pin lives on the FIRST
//   connect and later tests assert reconnects do NOT re-run it.
//
// Also covered: the reconcile gating (no url/token ⇒ no connection; unchanged
// settings ⇒ no-op; token rotation ⇒ restart with the new token; cleared
// settings ⇒ stop), the exact SSE subscribe wire shape (filters, encoded
// token, Plex headers), the bootstrap grace window + ledger release, the
// finalized-session ledger helpers, SSE frame plumbing (CRLF, chunk splits,
// array payloads, noise immunity), the stopped-event pipeline (cross-check
// advisory stops, viewOffset override into PlayHistory, the GR27
// ledger-after-write rule, unknown-session ledgering), the 30s
// timeline-resync debounce into the /api/sync loopback, reachability
// persistence dedupe/retry, and stream-end reconnection.
//
// Harness: no DB, network, or DNS. globalThis.prisma is pre-seeded with a
// recording fake BEFORE the module graph loads (the poster-cache pattern), so
// plex-events AND the play-history module underneath it share one in-memory
// surface — play-history's internals are the sibling suite's job; here they
// are only observed through the prisma calls they issue. globalThis.fetch is
// scripted per URL: /status/sessions serves a scriptable snapshot,
// /:/eventsource/notifications hands out hand-controlled ReadableStreams
// (push/end), and 127.0.0.1/api/sync records the internal-trigger loopback
// (tests/internal-trigger.test.mts owns that module's internals; here we only
// pin WHEN it fires). The Plex URL is an RFC1918 IP literal, which
// safeFetchAdminConfigured admits with allowPrivate=true and — being an IP
// literal — never resolves via DNS; dns.lookup is stubbed anyway as a
// belt-and-braces guard. Mock timers are used ONLY for the 30s timeline
// debounce; the reconnect tests run on real timers because a connection torn
// down under mock timers can't clear its pre-mock (real) 22h recycle timer —
// the mock clearTimeout doesn't know real handles — which leaks a ref'd
// Timeout and hangs the test process at exit.
//
// Deliberately NOT pinned (disproportionate scaffolding / other owners):
// the exact backoff-doubling schedule and STABLE_CONNECTION_MS reset, the 22h
// periodic recycle, the 2s snapshot-throttle trailing edge, and everything
// recordCompletedSession computes internally beyond what the recorded
// PlayHistory payload shows.
import { test } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32); // prisma.ts pulls in token-crypto
process.env.CRON_SECRET = "plex-events-test-cron-secret-0123456789abcdef";
delete process.env.PORT;
delete process.env.BASE_PATH;

// ── DNS stub (belt and braces — the IP-literal Plex URL never hits DNS) ─────
const fakeLookup = async () => [{ address: "93.184.216.34", family: 4 }];
(dns as { lookup: unknown }).lookup = fakeLookup;
if ((dns as { lookup: unknown }).lookup !== fakeLookup) {
  throw new Error("could not stub dns.lookup — aborting before a real DNS query can leave the process");
}

// ── console capture ─────────────────────────────────────────────────────────
const warns: string[] = [];
const errors: string[] = [];
console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

// ── recording fake prisma (pre-seeded on globalThis before the graph loads) ─
type DbCall = { model: string; op: string; args: unknown };
const dbCalls: DbCall[] = [];
function rec(model: string, op: string, args: unknown): void {
  dbCalls.push({ model, op, args });
}

interface FakeSessionRow {
  id: string;
  source: string;
  sessionKey: string;
  startedAt: Date;
  lastSeenAt: Date;
  state: string;
  mediaServerUserId: string;
  serverUsername: string;
  tmdbId: number | null;
  mediaType: string | null;
  title: string;
  year: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  episodeTitle: string | null;
  sourceItemId: string | null;
  posterPath: string | null;
  progressPercent: number;
  progressMs: bigint;
  progressUpdatedAt: Date;
  playtimeMs: bigint;
  durationMs: bigint;
  platform: string | null;
  player: string | null;
  device: string | null;
  ipAddress: string | null;
  playMethod: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  resolution: string | null;
  bitrate: number | null;
  videoDecision: string | null;
  audioDecision: string | null;
  container: string | null;
  transcodeReason: string | null;
  location: string | null;
  bandwidth: number | null;
  secure: boolean | null;
  relayed: boolean | null;
  introStartMs: number | null;
  introEndMs: number | null;
  creditsStartMs: number | null;
  creditsEndMs: number | null;
}

// Scriptable state the fake serves from.
let plexServerUrl: string | null = null;
let plexAdminToken: string | null = null;
let bootstrapRows: FakeSessionRow[] = []; // activeSession.findMany({ where: { source: "plex" } })
const liveRows = new Map<string, FakeSessionRow>(); // activeSession.findUnique by id
let settingUpsertError: Error | null = null;
let playHistoryCreateError: Error | null = null;
const settingUpserts: Array<{ key: string; value: string }> = [];

interface SettingFindManyArgs { where?: { key?: { in?: string[] } } }
interface SettingUpsertArgs { where: { key: string }; create: { key: string; value: string } }
interface ActiveWhereArgs { where?: { id?: string; source?: string; lastSeenAt?: Date } }
interface UpdateManyArgs extends ActiveWhereArgs { data: Record<string, unknown> }
interface CreateManyArgs { data: Array<Record<string, unknown>>; skipDuplicates?: boolean }

const fakePrisma = {
  setting: {
    findMany: async (args?: SettingFindManyArgs) => {
      rec("setting", "findMany", args);
      const keys = args?.where?.key?.in ?? [];
      const rows: Array<{ key: string; value: string }> = [];
      for (const k of keys) {
        if (k === "plexServerUrl" && plexServerUrl !== null) rows.push({ key: k, value: plexServerUrl });
        else if (k === "plexAdminToken" && plexAdminToken !== null) rows.push({ key: k, value: plexAdminToken });
        // play-history's loadSettings caches for 15s process-wide, so the
        // enable flags are pinned "true" for the whole file; reconcile gating
        // is exercised through the (uncached) url/token settings instead.
        else if (k === "playHistoryEnabled" || k === "playHistoryPlexEnabled") rows.push({ key: k, value: "true" });
      }
      return rows;
    },
    upsert: async (args: SettingUpsertArgs) => {
      rec("setting", "upsert", args);
      if (settingUpsertError) throw settingUpsertError;
      settingUpserts.push({ key: args.where.key, value: args.create.value });
      return args.create;
    },
  },
  activeSession: {
    updateMany: async (args: UpdateManyArgs) => {
      rec("activeSession", "updateMany", args);
      if (args.where?.id) return { count: liveRows.has(args.where.id) ? 1 : 0 };
      return { count: bootstrapRows.length }; // the where-less boot re-anchor
    },
    findMany: async (args?: ActiveWhereArgs) => {
      rec("activeSession", "findMany", args);
      if (args?.where?.source === "plex") return bootstrapRows;
      return []; // emitActiveSessionsSnapshot's select-shaped read
    },
    findUnique: async (args: { where: { id: string } }) => {
      rec("activeSession", "findUnique", args);
      return liveRows.get(args.where.id) ?? null;
    },
    deleteMany: async (args: ActiveWhereArgs) => {
      rec("activeSession", "deleteMany", args);
      return { count: 1 };
    },
  },
  playHistory: {
    createMany: async (args: CreateManyArgs) => {
      rec("playHistory", "createMany", args);
      if (playHistoryCreateError) throw playHistoryCreateError;
      return { count: args.data.length };
    },
    findFirst: async (args: unknown) => {
      rec("playHistory", "findFirst", args);
      return null;
    },
  },
  tmdbCache: {
    findUnique: async () => null,
    findMany: async () => [],
  },
};
(globalThis as unknown as { prisma: unknown }).prisma = fakePrisma;

// ── scripted fetch: /status/sessions, the SSE endpoint, the sync loopback ───
const PLEX_URL = "http://192.168.77.10:32400"; // IP literal: SSRF admin policy passes it without DNS
const TOKEN1 = "sse token/1+2"; // needs URL-encoding — pins the encodeURIComponent in the SSE URL
const TOKEN2 = "rotated token/2";

interface StreamHandle { push(text: string): void; end(): void; ended: boolean }
const sseStreams: StreamHandle[] = [];
let plexSnapshotSessions: Array<Record<string, unknown>> = [];

type FetchRecord = { url: string; headers: Headers; init: RequestInit };
const fetchLog: FetchRecord[] = [];
const encoder = new TextEncoder();

function makeSseResponse(): Response {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(c) { controller = c; },
  });
  if (!controller) throw new Error("ReadableStream start() did not run synchronously");
  const c = controller;
  const handle: StreamHandle = {
    ended: false,
    push(text: string) { c.enqueue(encoder.encode(text)); },
    end() {
      if (!handle.ended) {
        handle.ended = true;
        c.close();
      }
    },
  };
  sseStreams.push(handle);
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  fetchLog.push({ url, headers: new Headers(init?.headers), init: init ?? {} });
  const parsed = new URL(url);
  if (parsed.pathname === "/status/sessions") {
    return new Response(JSON.stringify({ MediaContainer: { Metadata: plexSnapshotSessions } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  if (parsed.pathname === "/:/eventsource/notifications") {
    return makeSseResponse();
  }
  if (parsed.hostname === "127.0.0.1" && parsed.pathname === "/api/sync") {
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }
  throw new Error(`unexpected fetch in test: ${url}`);
}) as typeof fetch;

const sseFetches = () => fetchLog.filter((c) => c.url.includes("/:/eventsource/notifications"));
const sessionFetches = () => fetchLog.filter((c) => c.url.includes("/status/sessions"));
const syncFetches = () => fetchLog.filter((c) => c.url.includes("/api/sync"));

// ── dynamic imports (stubs above genuinely precede the module graph) ────────
const {
  PLEX_STALL_THRESHOLD_MS,
  markPlexSessionFinalized,
  isPlexSessionRecentlyFinalized,
  pruneRecentlyFinalized,
  clearFinalizedNotInCurrentSnapshot,
  reconcilePlexEventStream,
  setPlexReachable,
} = await import("../src/lib/plex-events.ts");
const { sseEmitter } = await import("../src/lib/sse-emitter.ts");

const sseEvents: Array<Record<string, unknown> & { type: string }> = [];
sseEmitter.on("event", (e) => sseEvents.push(e as Record<string, unknown> & { type: string }));

// ── helpers ─────────────────────────────────────────────────────────────────

// setImmediate-based so it keeps working while t.mock.timers has replaced
// setTimeout; each turn also drains the full microtask cascade in between.
async function drain(turns = 25): Promise<void> {
  for (let i = 0; i < turns; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function waitFor(cond: () => boolean, what: string, attempts = 4000): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (cond()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${what}`);
}

// Real-clock variants for the reconnect tests, which deliberately run WITHOUT
// mock timers: the run loop's finally must clear its REAL 22h recycle timer
// with the REAL clearTimeout. (Tearing a connection down while t.mock.timers
// owns the globals leaks that pre-mock timer forever and the test process
// never exits.) The only wall-clock cost is the 1s initial backoff.
async function sleepMs(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForMs(cond: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await sleepMs(5);
  }
  throw new Error(`timed out (wall clock) waiting for ${what}`);
}

function activeRow(key: string, over: Partial<FakeSessionRow> = {}): FakeSessionRow {
  const now = Date.now();
  return {
    id: `plex:${key}`,
    source: "plex",
    sessionKey: key,
    startedAt: new Date(now - 2_000_000),
    lastSeenAt: new Date(now - 30_000),
    state: "paused", // paused ⇒ applyFinalTick contributes 0, keeping durations deterministic
    mediaServerUserId: "msu-1",
    serverUsername: "alice",
    tmdbId: null, // null skips the tmdbCache poster read inside recordCompletedSession
    mediaType: null,
    title: "Test Movie",
    year: "2020",
    seasonNumber: null,
    episodeNumber: null,
    episodeTitle: null,
    sourceItemId: null, // null skips the resume-grouping playHistory.findFirst
    posterPath: null,
    progressPercent: 0,
    progressMs: 100_000n,
    progressUpdatedAt: new Date(now - 30_000),
    playtimeMs: 100_000n,
    durationMs: 1_260_000n,
    platform: null,
    player: null,
    device: null,
    ipAddress: null,
    playMethod: null,
    videoCodec: null,
    audioCodec: null,
    resolution: null,
    bitrate: null,
    videoDecision: null,
    audioDecision: null,
    container: null,
    transcodeReason: null,
    location: null,
    bandwidth: null,
    secure: null,
    relayed: null,
    introStartMs: null,
    introEndMs: null,
    creditsStartMs: null,
    creditsEndMs: null,
    ...over,
  };
}

function armLiveRow(key: string, over: Partial<FakeSessionRow> = {}): FakeSessionRow {
  const row = activeRow(key, over);
  liveRows.set(row.id, row);
  return row;
}

function currentStream(): StreamHandle {
  const s = sseStreams[sseStreams.length - 1];
  if (!s) throw new Error("no SSE stream has been opened yet");
  return s;
}

function pushFrame(text: string): void {
  currentStream().push(text);
}

function playingFrame(n: unknown): string {
  return `event: playing\ndata: ${JSON.stringify({ PlaySessionStateNotification: n })}\n\n`;
}

function timelineFrame(e: unknown): string {
  return `event: timeline\ndata: ${JSON.stringify({ TimelineEntry: e })}\n\n`;
}

// The where-less lastSeenAt updateMany that reanchorActiveSessionsOnBoot issues.
function reanchorCalls(): DbCall[] {
  return dbCalls.filter((c) => {
    if (c.model !== "activeSession" || c.op !== "updateMany") return false;
    const a = c.args as UpdateManyArgs;
    return !a.where && a.data?.lastSeenAt instanceof Date;
  });
}

function updatesFor(id: string): UpdateManyArgs[] {
  return dbCalls
    .filter((c) => c.model === "activeSession" && c.op === "updateMany" && (c.args as UpdateManyArgs).where?.id === id)
    .map((c) => c.args as UpdateManyArgs);
}

function deletesFor(id: string): ActiveWhereArgs[] {
  return dbCalls
    .filter((c) => c.model === "activeSession" && c.op === "deleteMany" && (c.args as ActiveWhereArgs).where?.id === id)
    .map((c) => c.args as ActiveWhereArgs);
}

function historyRows(): Array<Record<string, unknown>> {
  return dbCalls
    .filter((c) => c.model === "playHistory" && c.op === "createMany")
    .flatMap((c) => (c.args as CreateManyArgs).data);
}

// ═══ Phase A — module-surface helpers (no stream involved) ══════════════════

test("PLEX_STALL_THRESHOLD_MS is the 60s stall contract the 5s poller imports", () => {
  assert.equal(PLEX_STALL_THRESHOLD_MS, 60_000);
});

test("finalized ledger: mark/check round-trips and prune is strict-greater on the 1h TTL", () => {
  const t0 = 1_000_000;
  markPlexSessionFinalized("plex:ledger-a", t0);
  assert.equal(isPlexSessionRecentlyFinalized("plex:ledger-a"), true);
  assert.equal(isPlexSessionRecentlyFinalized("plex:never-marked"), false);

  // Exactly TTL old is NOT pruned (`>` comparison), TTL+1 is.
  pruneRecentlyFinalized(t0 + 60 * 60 * 1000);
  assert.equal(isPlexSessionRecentlyFinalized("plex:ledger-a"), true, "an entry exactly TTL old must survive the strict-greater prune");
  pruneRecentlyFinalized(t0 + 60 * 60 * 1000 + 1);
  assert.equal(isPlexSessionRecentlyFinalized("plex:ledger-a"), false, "an entry older than the 1h TTL must be pruned");
});

test("clearFinalizedNotInCurrentSnapshot releases only plex:-prefixed keys absent from the snapshot", () => {
  markPlexSessionFinalized("plex:kept");
  markPlexSessionFinalized("plex:gone");
  markPlexSessionFinalized("jellyfin:other"); // non-plex ids are never touched by the Plex snapshot
  clearFinalizedNotInCurrentSnapshot(new Set(["kept"]));
  assert.equal(isPlexSessionRecentlyFinalized("plex:kept"), true, "a key Plex still reports stays ledgered (the ghost is still in /status/sessions)");
  assert.equal(isPlexSessionRecentlyFinalized("plex:gone"), false, "a key Plex dropped is released so a future play reusing it is visible");
  assert.equal(isPlexSessionRecentlyFinalized("jellyfin:other"), true, "non-plex ledger entries are out of scope for the Plex snapshot");

  // Leave the ledger empty for the connection phases below.
  pruneRecentlyFinalized(Number.MAX_SAFE_INTEGER);
  assert.equal(isPlexSessionRecentlyFinalized("plex:kept"), false);
  assert.equal(isPlexSessionRecentlyFinalized("jellyfin:other"), false);
});

// ═══ Phase B — reconcile gating before any connection ═══════════════════════

test("reconcile without plexServerUrl/plexAdminToken opens no connection and burns no boot re-anchor", async () => {
  await reconcilePlexEventStream();
  await drain();
  assert.equal(fetchLog.length, 0, "no config ⇒ no network traffic at all");
  assert.equal(
    dbCalls.filter((c) => c.model === "activeSession").length,
    0,
    "a non-starting reconcile must not touch ActiveSession (the once-per-process re-anchor stays unspent for the first real connect)",
  );
});

// ═══ Phase C — first connect: guardrail 21, wire shape, bootstrap grace ═════

// Arranged in the first test, inspected across the next two: the boot
// re-anchor is once-guarded per process, so there is exactly ONE first connect
// to pin it on.
const bootStale = activeRow("boot-stale", { lastSeenAt: new Date(Date.now() - 120_000) });
const bootFresh = activeRow("boot-fresh", { lastSeenAt: new Date(Date.now() - 5_000) });

test("GUARDRAIL 21: the boot re-anchor updateMany runs before any ActiveSession read in bootstrapReconcile", async () => {
  bootstrapRows = [bootStale, bootFresh];
  plexSnapshotSessions = [{ sessionKey: "boot-live" }];
  markPlexSessionFinalized("plex:boot-ghost"); // absent from the snapshot ⇒ must be released
  markPlexSessionFinalized("plex:boot-live"); // present in the snapshot ⇒ must be kept
  plexServerUrl = PLEX_URL;
  plexAdminToken = TOKEN1;

  await reconcilePlexEventStream();
  await waitFor(() => sseFetches().length >= 1, "the first SSE subscribe (bootstrap completes before it)");

  const firstActiveIdx = dbCalls.findIndex((c) => c.model === "activeSession");
  assert.notEqual(firstActiveIdx, -1, "the first connect must touch ActiveSession");
  const first = dbCalls[firstActiveIdx];
  assert.equal(
    first.op,
    "updateMany",
    "guardrail 21: the FIRST ActiveSession operation of the process must be the boot re-anchor updateMany — a read before it measures the absence grace from a pre-restart lastSeenAt and finalizes still-playing sessions",
  );
  const reanchorArgs = first.args as UpdateManyArgs;
  assert.equal(reanchorArgs.where, undefined, "guardrail 21: the re-anchor covers EVERY row (no where clause)");
  assert.ok(reanchorArgs.data.lastSeenAt instanceof Date, "guardrail 21: the re-anchor sets lastSeenAt to a fresh Date");

  const bootReadIdx = dbCalls.findIndex(
    (c) => c.model === "activeSession" && c.op === "findMany" && (c.args as ActiveWhereArgs).where?.source === "plex",
  );
  assert.notEqual(bootReadIdx, -1, "bootstrapReconcile must read the plex ActiveSession rows");
  assert.ok(
    firstActiveIdx < bootReadIdx,
    "guardrail 21: reanchorActiveSessionsOnBoot() must complete BEFORE the stale-sweep read — reordering re-exposes the restart finalize-and-ledger-lock bug",
  );
});

test("SSE subscribe wire shape: filters=playing,timeline, URL-encoded token, Plex client headers", () => {
  const call = sseFetches()[0];
  const url = new URL(call.url);
  assert.equal(url.origin, "http://192.168.77.10:32400");
  assert.equal(url.pathname, "/:/eventsource/notifications");
  assert.equal(url.searchParams.get("filters"), "playing,timeline");
  assert.equal(url.searchParams.get("X-Plex-Token"), TOKEN1);
  // The raw URL must carry the encodeURIComponent form — an unencoded token
  // with spaces/+/slashes corrupts the query string.
  assert.ok(call.url.includes("X-Plex-Token=sse%20token%2F1%2B2"), `token must be URL-encoded in the wire URL, got: ${call.url}`);
  assert.equal(call.headers.get("accept"), "text/event-stream");
  assert.equal(call.headers.get("x-plex-product"), "Summonarr");
  assert.equal(call.headers.get("x-plex-version"), "1.0");
  assert.ok(call.init.signal instanceof AbortSignal, "the abort signal must ride the SSE request so stop()/recycle can kill it");
});

test("bootstrap grace: a >=60s-absent row is finalized and ledgered, a <60s-absent row is spared, and dropped ledger keys are released", async () => {
  // Both rows were absent from the snapshot; only the stale one crossed
  // SESSION_ABSENCE_GRACE_MS. This is the window the guardrail-21 re-anchor
  // exists to protect: with lastSeenAt re-anchored to boot, a transient boot
  // absence stays under 60s and must NOT finalize.
  const rows = historyRows();
  assert.equal(rows.length, 1, "exactly one bootstrap finalize (the stale row)");
  assert.equal(rows[0].source, "plex");
  assert.equal(
    rows[0].sourceSessionId,
    `boot-stale:${bootStale.startedAt.toISOString()}`,
    "the finalized PlayHistory row keys off the stale session",
  );
  assert.equal(isPlexSessionRecentlyFinalized("plex:boot-stale"), true, "the finalized session is ledgered against poller re-creates");
  assert.equal(isPlexSessionRecentlyFinalized("plex:boot-fresh"), false, "a session absent for <60s must NOT be finalized or ledgered");
  assert.equal(deletesFor("plex:boot-fresh").length, 0, "the spared row is left alone");

  // clearFinalizedNotInCurrentSnapshot integration: boot-ghost was not in the
  // snapshot (released); boot-live was (kept).
  assert.equal(isPlexSessionRecentlyFinalized("plex:boot-ghost"), false, "ledger entries for keys Plex no longer reports are released at bootstrap");
  assert.equal(isPlexSessionRecentlyFinalized("plex:boot-live"), true, "ledger entries for keys still in the snapshot survive bootstrap");

  // A successful getPlexSessions marks the server reachable (fire-and-forget).
  await waitFor(() => settingUpserts.some((u) => u.key === "plexServerReachable"), "reachability upsert");
  const persisted = JSON.parse(settingUpserts.find((u) => u.key === "plexServerReachable")!.value) as { reachable: boolean };
  assert.equal(persisted.reachable, true);
  assert.ok(
    sseEvents.some((e) => e.type === "plex:reachability" && e.reachable === true),
    "reachability flip is broadcast over SSE",
  );

  bootstrapRows = []; // keep later reconnect bootstraps quiet
});

// ═══ Phase D — guardrail 20: the SSE `playing` writer and the stall anchor ══

test("playhead moved FORWARD: progressUpdatedAt refreshes and progressMs is written", async () => {
  armLiveRow("g20-fwd", { state: "playing", progressMs: 10_000n });
  pushFrame(playingFrame({ sessionKey: "g20-fwd", state: "playing", viewOffset: 15_000 }));
  await waitFor(() => updatesFor("plex:g20-fwd").length === 1, "live-state update for g20-fwd");
  const upd = updatesFor("plex:g20-fwd")[0];
  assert.equal(upd.data.state, "playing");
  assert.equal(upd.data.progressMs, 15_000n);
  assert.ok(
    upd.data.progressUpdatedAt instanceof Date,
    "guardrail 20: a forward playhead move must refresh the stall anchor",
  );
  // count>0 ⇒ the manager pushes a sessions snapshot (leading edge of the throttle).
  await waitFor(() => sseEvents.some((e) => e.type === "activity:sessions"), "sessions snapshot after a live-state write");
});

test("GUARDRAIL 20: a BACKWARD seek is movement — the anchor refreshes on !==, not only on strict advance", async () => {
  armLiveRow("g20-back", { state: "playing", progressMs: 10_000n });
  pushFrame(playingFrame({ sessionKey: "g20-back", state: "playing", viewOffset: 5_000 }));
  await waitFor(() => updatesFor("plex:g20-back").length === 1, "live-state update for g20-back");
  const upd = updatesFor("plex:g20-back")[0];
  assert.equal(upd.data.progressMs, 5_000n);
  assert.ok(
    upd.data.progressUpdatedAt instanceof Date,
    "guardrail 20: viewOffset (5000) != stored progressMs (10000) is playhead MOVEMENT — regressing to a strict `>` advance check suppresses this refresh and lets the 5s poller stall-finalize a live, rewinding stream",
  );
});

test("GUARDRAIL 20: an IDENTICAL viewOffset (frozen ghost) must NOT refresh the stall anchor", async () => {
  armLiveRow("g20-frozen", { state: "playing", progressMs: 10_000n });
  pushFrame(playingFrame({ sessionKey: "g20-frozen", state: "playing", viewOffset: 10_000 }));
  await waitFor(() => updatesFor("plex:g20-frozen").length === 1, "live-state update for g20-frozen");
  const upd = updatesFor("plex:g20-frozen")[0];
  assert.equal(upd.data.progressMs, 10_000n, "progressMs itself is still written (harmless no-op value)");
  assert.ok(
    !("progressUpdatedAt" in upd.data),
    "guardrail 20: a frozen playhead (viewOffset === stored progressMs, no state transition) must NOT refresh progressUpdatedAt — refreshing it keeps a genuine ghost alive forever and defeats the 60s stall detector",
  );
});

test("GUARDRAIL 20: a pause→playing transition refreshes the anchor even with an unchanged offset", async () => {
  armLiveRow("g20-resume", { state: "paused", progressMs: 10_000n });
  pushFrame(playingFrame({ sessionKey: "g20-resume", state: "playing", viewOffset: 10_000 }));
  await waitFor(() => updatesFor("plex:g20-resume").length === 1, "live-state update for g20-resume");
  const upd = updatesFor("plex:g20-resume")[0];
  assert.equal(upd.data.state, "playing");
  assert.ok(
    upd.data.progressUpdatedAt instanceof Date,
    "guardrail 20: transitionedToPlaying must refresh the anchor — the playhead was legitimately parked during the pause, and without the refresh the first poll after resume stall-finalizes",
  );
});

test("missing or negative viewOffset writes state only — no progressMs, no anchor refresh without a transition", async () => {
  armLiveRow("g20-nooff", { state: "playing", progressMs: 7_000n });
  pushFrame(playingFrame({ sessionKey: "g20-nooff", state: "paused" })); // no viewOffset
  await waitFor(() => updatesFor("plex:g20-nooff").length === 1, "first update (no offset)");
  const noOffset = updatesFor("plex:g20-nooff")[0];
  assert.deepEqual(Object.keys(noOffset.data), ["state"], "an offset-less event must write ONLY the state");
  assert.equal(noOffset.data.state, "paused");

  pushFrame(playingFrame({ sessionKey: "g20-nooff", state: "paused", viewOffset: -50 }));
  await waitFor(() => updatesFor("plex:g20-nooff").length === 2, "second update (negative offset)");
  const negative = updatesFor("plex:g20-nooff")[1];
  assert.deepEqual(Object.keys(negative.data), ["state"], "a negative viewOffset is rejected: no progressMs write, no anchor refresh");
});

test("ledgered and never-tracked sessions are ignored by live-state updates", async () => {
  markPlexSessionFinalized("plex:g20-ledgered");
  armLiveRow("g20-ledgered", { state: "playing", progressMs: 1_000n }); // row exists, but the ledger must win
  pushFrame(playingFrame({ sessionKey: "g20-ledgered", state: "playing", viewOffset: 2_000 }));
  pushFrame(playingFrame({ sessionKey: "g20-unknown", state: "playing", viewOffset: 3_000 })); // no DB row
  // Sentinel proves both frames were consumed before we assert the negatives.
  armLiveRow("g20-sentinel", { state: "playing", progressMs: 1_000n });
  pushFrame(playingFrame({ sessionKey: "g20-sentinel", state: "playing", viewOffset: 9_000 }));
  await waitFor(() => updatesFor("plex:g20-sentinel").length === 1, "sentinel update");

  assert.equal(
    dbCalls.filter((c) => c.model === "activeSession" && (c.args as { where?: { id?: string } }).where?.id === "plex:g20-ledgered").length,
    0,
    "a recently-finalized session is short-circuited BEFORE any DB read — a late state event must not resurrect it",
  );
  assert.equal(updatesFor("plex:g20-unknown").length, 0, "no ActiveSession row ⇒ no update write");
});

// ═══ Phase E — the stopped-event pipeline ═══════════════════════════════════

test("a spurious stop while /status/sessions still lists the session is advisory: no finalize, no ledger, row kept", async () => {
  armLiveRow("stop-alive", { state: "playing" });
  plexSnapshotSessions = [{ sessionKey: "stop-alive" }];
  const histBefore = historyRows().length;
  const sessBefore = sessionFetches().length;

  pushFrame(playingFrame({ sessionKey: "stop-alive", state: "stopped", viewOffset: 42_000 }));
  await waitFor(() => sessionFetches().length === sessBefore + 1, "the /status/sessions cross-check fetch");
  await drain(40);

  assert.equal(isPlexSessionRecentlyFinalized("plex:stop-alive"), false, "an advisory stop must NOT ledger-lock the sessionKey");
  assert.equal(historyRows().length, histBefore, "an advisory stop must NOT write a PlayHistory row");
  assert.equal(deletesFor("plex:stop-alive").length, 0, "an advisory stop must NOT delete the ActiveSession");
});

test("a real stop threads the SSE viewOffset into the PlayHistory row, ledgers the key, and force-cleans the ActiveSession", async () => {
  plexSnapshotSessions = []; // cross-check confirms the session is gone
  const row = armLiveRow("stop-real", {
    state: "paused", // final tick contributes 0 ⇒ durations below are exact
    playtimeMs: 100_000n,
    progressMs: 100_000n,
    durationMs: 1_260_000n,
    startedAt: new Date(Date.now() - 2_000_000),
    lastSeenAt: new Date(Date.now() - 30_000),
  });

  pushFrame(playingFrame({ sessionKey: "stop-real", state: "stopped", viewOffset: 1_234_567 }));
  await waitFor(
    () => historyRows().some((r) => r.sourceSessionId === `stop-real:${row.startedAt.toISOString()}`),
    "PlayHistory write for stop-real",
  );
  const hist = historyRows().find((r) => r.sourceSessionId === `stop-real:${row.startedAt.toISOString()}`)!;
  // playDuration = max(playtimeMs 100000, min(viewOffset 1234567, wallElapsed ~2000000)) — the
  // stored progressMs (100000) alone could never produce 1234s, so this pins that the
  // stop event's fresher viewOffset overrode the lagging poll snapshot.
  assert.equal(hist.playDuration, 1234, "the SSE stop viewOffset (not the stale stored progressMs) drives the finalized playDuration");
  assert.equal(hist.watched, true);
  assert.equal(hist.completed, true, "1234567/1260000 ≈ 0.98 ≥ 0.95 completes only via the overridden offset");
  assert.equal(hist.mediaServerUserId, "msu-1");

  assert.equal(isPlexSessionRecentlyFinalized("plex:stop-real"), true, "a real stop ledger-locks the key against poller re-creates");

  await waitFor(() => deletesFor("plex:stop-real").length === 2, "both ActiveSession deletes");
  const [casDelete, forceClean] = deletesFor("plex:stop-real");
  assert.equal(casDelete.where?.lastSeenAt, row.lastSeenAt, "recordCompletedSession's delete is CAS-guarded on the lastSeenAt it read");
  assert.equal(forceClean.where?.lastSeenAt, undefined, "the SSE force-clean delete is unconditional — SSE stop is authoritative even if the poller bumped lastSeenAt");
});

test("GR27: a failed PlayHistory write leaves the session un-ledgered so a later stop can retry and finalize", async () => {
  plexSnapshotSessions = [];
  armLiveRow("stop-fail", { state: "paused" });
  playHistoryCreateError = new Error("db down");

  pushFrame(playingFrame({ sessionKey: "stop-fail", state: "stopped", viewOffset: 900_000 }));
  await waitFor(() => warns.some((w) => w.includes("finalize stop failed for plex:stop-fail")), "the finalize-failed warn");
  assert.equal(
    isPlexSessionRecentlyFinalized("plex:stop-fail"),
    false,
    "guardrail 27: the ledger mark goes AFTER the PlayHistory write commits — a failed write must not ledger-lock the key for an hour with no history row",
  );
  assert.equal(deletesFor("plex:stop-fail").length, 0, "no ActiveSession delete on a failed finalize — the poller must be able to retry");

  playHistoryCreateError = null;
  pushFrame(playingFrame({ sessionKey: "stop-fail", state: "stopped", viewOffset: 900_000 }));
  await waitFor(() => isPlexSessionRecentlyFinalized("plex:stop-fail"), "the retry stop finalizing");
  assert.ok(
    historyRows().some((r) => typeof r.sourceSessionId === "string" && (r.sourceSessionId as string).startsWith("stop-fail:")),
    "the retried stop writes the PlayHistory row",
  );
});

test("a stop for a session we never tracked just ledgers the key (no cross-check, no writes)", async () => {
  const sessBefore = sessionFetches().length;
  const histBefore = historyRows().length;
  pushFrame(playingFrame({ sessionKey: "stop-ghost", state: "stopped", viewOffset: 1_000 }));
  await waitFor(() => isPlexSessionRecentlyFinalized("plex:stop-ghost"), "ledger mark for the unseen session");
  await drain(20);
  assert.equal(sessionFetches().length, sessBefore, "no /status/sessions cross-check for a session with no DB row");
  assert.equal(historyRows().length, histBefore, "no PlayHistory row for a session we never observed");
  assert.equal(deletesFor("plex:stop-ghost").length, 0);
});

// ═══ Phase F — SSE frame plumbing and event routing ═════════════════════════

test("frame plumbing: CRLF endings, frames split across chunks, and array payloads all parse", async () => {
  // CRLF line endings (defensive normalization — Plex currently emits LF).
  armLiveRow("fr-crlf", { state: "playing", progressMs: 1_000n });
  pushFrame(
    `event: playing\r\ndata: ${JSON.stringify({ PlaySessionStateNotification: { sessionKey: "fr-crlf", state: "playing", viewOffset: 2_000 } })}\r\n\r\n`,
  );
  await waitFor(() => updatesFor("plex:fr-crlf").length === 1, "CRLF frame handled");

  // One frame delivered across two reads must be reassembled, not dropped.
  armLiveRow("fr-split", { state: "playing", progressMs: 1_000n });
  const whole = playingFrame({ sessionKey: "fr-split", state: "playing", viewOffset: 3_000 });
  pushFrame(whole.slice(0, 20));
  await drain(10);
  pushFrame(whole.slice(20));
  await waitFor(() => updatesFor("plex:fr-split").length === 1, "chunk-split frame handled");

  // Tautulli-style array payloads fan out per notification.
  armLiveRow("fr-a1", { state: "playing", progressMs: 1_000n });
  armLiveRow("fr-a2", { state: "playing", progressMs: 1_000n });
  pushFrame(playingFrame([
    { sessionKey: "fr-a1", state: "playing", viewOffset: 4_000 },
    { sessionKey: "fr-a2", state: "playing", viewOffset: 5_000 },
  ]));
  await waitFor(
    () => updatesFor("plex:fr-a1").length === 1 && updatesFor("plex:fr-a2").length === 1,
    "both array-payload notifications handled",
  );
});

test("noise immunity: comments, unknown events, malformed JSON, and missing sessionKey are ignored without killing the stream", async () => {
  const errBefore = errors.length;
  pushFrame(": keep-alive heartbeat\n\n"); // comment-only frame — no data
  pushFrame(`event: log\ndata: {"whatever":1}\n\n`); // unrouted event type
  pushFrame("event: playing\ndata: {not json at all\n\n"); // malformed JSON — silently dropped
  pushFrame(playingFrame({ state: "playing", viewOffset: 1_000 })); // no sessionKey — skipped
  pushFrame(`data: ${JSON.stringify({ PlaySessionStateNotification: { sessionKey: "noise-noevent", state: "playing", viewOffset: 1 } })}\n\n`); // data without an event field

  armLiveRow("noise-sentinel", { state: "playing", progressMs: 1_000n });
  pushFrame(playingFrame({ sessionKey: "noise-sentinel", state: "playing", viewOffset: 2_000 }));
  await waitFor(() => updatesFor("plex:noise-sentinel").length === 1, "sentinel frame after the noise — the read loop must still be alive");

  assert.equal(updatesFor("plex:noise-noevent").length, 0, "a data frame without event: playing is not routed");
  assert.equal(errors.length, errBefore, "noise never console.errors");
  assert.ok(!warns.some((w) => w.includes("loop crashed")), "noise never crashes the run loop");
});

// ═══ Phase G — timeline events → debounced full-sync loopback ═══════════════

test("timeline: terminal states debounce-coalesce into ONE /api/sync loopback 30s after the LAST event; scan-intermediate states never schedule", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const syncBefore = syncFetches().length;

  // queued/processing are intermediate scanner states — never a resync.
  pushFrame(timelineFrame([{ itemID: 1, metadataState: "queued" }, { itemID: 1, metadataState: "processing" }]));
  await drain(20);
  t.mock.timers.tick(120_000);
  await drain(20);
  assert.equal(syncFetches().length, syncBefore, "queued/processing timeline states must never trigger a sync");

  // created ... then updated 10s later: the 30s debounce restarts from the LAST event.
  pushFrame(timelineFrame({ itemID: 2, metadataState: "created" }));
  await drain(20);
  t.mock.timers.tick(10_000);
  await drain(10);
  pushFrame(timelineFrame({ itemID: 3, metadataState: "updated" }));
  await drain(20);
  t.mock.timers.tick(29_999); // 29_999ms after the LAST event — still inside the window
  await drain(20);
  assert.equal(syncFetches().length, syncBefore, "the debounce window restarts on every terminal event (30s from the LAST one)");

  t.mock.timers.tick(1);
  await waitFor(() => syncFetches().length === syncBefore + 1, "the debounced /api/sync loopback");
  await drain(30);
  assert.equal(syncFetches().length, syncBefore + 1, "a burst of timeline events coalesces into exactly ONE sync");

  const call = syncFetches()[syncFetches().length - 1];
  assert.equal(call.url, "http://127.0.0.1:3000/api/sync", "the resync rides the single allowed internal loopback (guardrail 5b)");
  assert.equal(call.headers.get("authorization"), `Bearer ${process.env.CRON_SECRET}`);
});

// ═══ Phase H — reachability persistence ═════════════════════════════════════

test("setPlexReachable dedupes repeats and persists+broadcasts flips", async () => {
  // Bootstrap already persisted true; an unchanged report must be a no-op.
  const upsBefore = settingUpserts.length;
  await setPlexReachable(true);
  assert.equal(settingUpserts.length, upsBefore, "an unchanged reachability value must not rewrite the Setting on every 5s poll");

  const evBefore = sseEvents.length;
  await setPlexReachable(false);
  assert.equal(settingUpserts.length, upsBefore + 1);
  const persisted = JSON.parse(settingUpserts[settingUpserts.length - 1].value) as { reachable: boolean; observedAt: string };
  assert.equal(persisted.reachable, false);
  assert.ok(typeof persisted.observedAt === "string" && !Number.isNaN(Date.parse(persisted.observedAt)));
  assert.ok(
    sseEvents.slice(evBefore).some((e) => e.type === "plex:reachability" && e.reachable === false),
    "the flip is broadcast so the UI badge updates without polling",
  );

  await setPlexReachable(false); // dedupe in the new state too
  assert.equal(settingUpserts.length, upsBefore + 1);
});

test("a failed reachability write is not latched — the next report retries the upsert", async () => {
  const upsBefore = settingUpserts.length;
  settingUpsertError = new Error("db unavailable");
  await setPlexReachable(true); // flip attempt fails
  assert.ok(warns.some((w) => w.includes("[plex-events] persist reachability failed: db unavailable")));
  assert.equal(settingUpserts.length, upsBefore, "the failed write recorded nothing");

  settingUpsertError = null;
  await setPlexReachable(true); // must NOT be deduped — the failure was not latched as persisted
  assert.equal(settingUpserts.length, upsBefore + 1, "the retry persists: only a SUCCESSFUL write may latch lastReachable");
  assert.equal((JSON.parse(settingUpserts[settingUpserts.length - 1].value) as { reachable: boolean }).reachable, true);
});

// ═══ Phase I — connection lifecycle ═════════════════════════════════════════

test("reconcile with unchanged settings is a no-op: no second connection, no re-bootstrap", async () => {
  const sseBefore = sseFetches().length;
  const sessBefore = sessionFetches().length;
  await reconcilePlexEventStream();
  await drain(30);
  assert.equal(sseFetches().length, sseBefore, "an unchanged config must reuse the live connection");
  assert.equal(sessionFetches().length, sessBefore, "no bootstrap re-run without a (re)connect");
});

test("stream end → automatic reconnect with a fresh bootstrap; the boot re-anchor does NOT run again", async () => {
  const sseBefore = sseFetches().length; // 1 live connection so far
  const sessBefore = sessionFetches().length;
  assert.equal(reanchorCalls().length, 1, "sanity: exactly one boot re-anchor before the reconnect");

  // Real timers on purpose (see sleepMs): the dying connection's finally must
  // clear its real recycle timer, and the ~1s initial backoff is cheap to wait.
  currentStream().end(); // server closed the stream — the loop must back off and reconnect
  await waitForMs(() => sseFetches().length === sseBefore + 1, "the post-backoff reconnect");

  assert.ok(sessionFetches().length > sessBefore, "every (re)connect re-runs the bootstrap reconcile snapshot");
  assert.equal(
    reanchorCalls().length,
    1,
    "guardrail 21: reanchorActiveSessionsOnBoot is once-guarded PER PROCESS — a mere reconnect re-running it would blind the absence grace to real downtime",
  );
  await drain(20);
  assert.equal(sseFetches().length, sseBefore + 1, "exactly one reconnect — no runaway loop");
});

test("a token change restarts the stream with the new token and never reconnects with the stale one", async () => {
  const sseBefore = sseFetches().length;

  const oldStream = currentStream();
  plexAdminToken = TOKEN2;
  await reconcilePlexEventStream();
  await waitFor(() => sseFetches().length === sseBefore + 1, "the restarted SSE subscribe");
  const fresh = new URL(sseFetches()[sseBefore].url);
  assert.equal(fresh.searchParams.get("X-Plex-Token"), TOKEN2, "the new connection must carry the rotated token");

  // Wind down the aborted old connection: its read resolves on stream end, its
  // finally clears the recycle timer, and after one (real) 1s backoff sleep
  // its loop must exit on the url/token ownership check instead of
  // reconnecting with the stale token.
  oldStream.end();
  await sleepMs(1_300);
  await drain(20);
  assert.equal(sseFetches().length, sseBefore + 1, "the old loop must exit — a reconnect with the stale token would leave two live connections");
  assert.equal(reanchorCalls().length, 1, "guardrail 21: the config-change reconnect must not re-run the boot re-anchor either");
});

test("removing the Plex config stops the loop for good, with no crash and no console.error anywhere", async () => {
  plexServerUrl = null;
  plexAdminToken = null;
  await reconcilePlexEventStream(); // stop(): abort + running=false + pending timers cleared
  for (const s of sseStreams) s.end(); // release any pending reads so every connection's finally runs

  await drain(60);
  const trafficAfterStop = fetchLog.length;
  await drain(60);
  assert.equal(fetchLog.length, trafficAfterStop, "a stopped manager must issue no further traffic");
  assert.ok(!warns.some((w) => w.includes("loop crashed")), "the run loop must never crash during the whole scenario");
  assert.ok(!warns.some((w) => w.includes("connection failing repeatedly")), "no persistent-outage warns — every disconnect in this suite was orderly");
  assert.deepEqual(errors, [], "plex-events must never console.error (warn-only logging convention)");
});
