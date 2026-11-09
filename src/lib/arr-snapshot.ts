// "Instant, then live" for the admin Radarr/Sonarr pages: the last successful
// answer of each admin arr READ is kept in memory, so a page opened again paints
// that answer at once (`?cached=1`, stamped with when it was read) and then
// reloads live from Radarr/Sonarr exactly as before.
//
// A snapshot is DISPLAY ONLY. Nothing that writes ever reads one: every admin
// arr write still re-checks against a fresh read of the instance (guardrail 5e),
// so acting on a row painted from a snapshot is acting on a NAME the server
// re-judges live.
//
// What is kept: the exact body a live 200 JSON answer sent, keyed by the read's
// path + query (minus `cached`) and the request's language (some bodies carry
// translated text). Never a background-job poll (`job=`), never a non-200 — so
// an arr that is down keeps its last good answer on screen, marked stale.
// Release searches and command reads are not wrapped at all: release handles are
// single-use and bound to one search (release-handles.ts).
//
// In-process only (processSingleton): a restart starts empty and the first open
// of each page fills it. Bounded by bytes, LRU, and a maximum age.
//
// Kept fresh in the background: every view an admin opened in the last
// SNAPSHOT_VIEW_WINDOW_MS is re-read on its page's PRIORITY — the queue and
// health every 5 minutes, Missing / history / calendar / the title manager every
// 10, Arr System every 15 (SNAPSHOT_REFRESH_TIERS) — by /api/cron/refresh-arr-
// snapshots, which re-runs the route's own handler, so the kept body is exactly
// what a live read answers. A refresh is not a view: a page nobody opens stops
// being refreshed once the window passes. A view whose re-reads keep failing
// backs off and goes after the views that answer (dueSnapshots).
import { NextRequest, NextResponse } from "next/server";
import { localeForRequest } from "@/lib/i18n/server-locale";
import { processSingleton } from "@/lib/process-singleton";
import { SNAPSHOT_HEADER } from "@/lib/client/arr-snapshot";
import { settleLimit } from "@/lib/concurrency";
import { warnOnChange } from "@/lib/log-dedup";
import type { SummonarrSession } from "@/lib/api-auth";

export { SNAPSHOT_HEADER };

/**
 * Total bytes kept across every page, instance and language — counted as the
 * bodies sit in memory (snapshotCharge), not as they went over the wire.
 */
export const SNAPSHOT_MAX_BYTES = 32 * 1024 * 1024;
/** A single answer larger than this is not kept (and drops an older copy). */
export const SNAPSHOT_MAX_ENTRY_BYTES = 4 * 1024 * 1024;
/** Older than this is never painted: a day-old queue is not "last known", it is wrong. */
export const SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** A view no admin has opened for this long is no longer refreshed in the background. */
export const SNAPSHOT_VIEW_WINDOW_MS = 24 * 60 * 60 * 1000;
/** At most this many re-reads per background run; the rest wait for the next one. */
export const SNAPSHOT_REFRESH_MAX_PER_RUN = 40;
/** Re-reads in flight at once — the arrs and the Prisma pool are shared (guardrail 31). */
export const SNAPSHOT_REFRESH_CONCURRENCY = 2;
/**
 * A view whose background re-reads keep failing waits its tier's interval after
 * the last attempt, doubled for each failure in a row, but never longer than this.
 */
export const SNAPSHOT_RETRY_MAX_WAIT_MS = 60 * 60_000;
// The cron runs every 5 minutes; a view read 4 minutes 30 seconds ago is due
// now, not 5 minutes from now.
const REFRESH_SLACK_MS = 60_000;

/**
 * How often each admin arr read is refreshed in the background, by priority.
 * The paths are the route paths below any basePath. A read not listed here is
 * never refreshed in the background (it still paints its last answer on open).
 */
export const SNAPSHOT_REFRESH_TIERS: ReadonlyArray<{ priority: "high" | "normal" | "low"; everyMs: number; paths: readonly string[] }> = [
  // What is moving right now, and what the nav badge and alerts are about.
  { priority: "high", everyMs: 5 * 60_000, paths: ["/api/admin/queue", "/api/admin/arr-health"] },
  { priority: "normal", everyMs: 10 * 60_000, paths: [
    "/api/admin/missing",
    "/api/admin/missing/episodes",
    "/api/admin/arr/history",
    "/api/admin/arr/blocklist",
    "/api/admin/arr/calendar",
    "/api/admin/arr/title",
    "/api/admin/arr/title/episodes",
    "/api/admin/arr/title/files",
    "/api/admin/arr/title/history",
  ] },
  // Tasks, indexers, clients and disks change slowly.
  { priority: "low", everyMs: 15 * 60_000, paths: ["/api/admin/arr/tasks", "/api/admin/arr/providers", "/api/admin/arr/storage"] },
];

/** The route path of a URL path, below any basePath ("/base/api/admin/queue" → "/api/admin/queue"). */
export function routePathOf(pathname: string): string {
  const i = pathname.indexOf("/api/");
  return i < 0 ? pathname : pathname.slice(i);
}

/** How often a read is refreshed in the background, or null when it never is. */
export function refreshEveryMs(pathname: string): number | null {
  const path = routePathOf(pathname);
  for (const tier of SNAPSHOT_REFRESH_TIERS) if (tier.paths.includes(path)) return tier.everyMs;
  return null;
}

interface Entry {
  body: string;
  at: number;
  bytes: number;
  /** When an admin last opened this view (a live read or a cached one). */
  viewedAt: number;
  /** The live read's URL (no `cached`) and language — what a background refresh re-reads. */
  url: string | null;
  locale: string | null;
  /** Background re-reads that failed in a row since this answer was kept. */
  failures: number;
  /** When the last of those failed re-reads ran; null with none. */
  failedAt: number | null;
}

// A stored route handler. The session is typed: the background refresh calls
// it with SYSTEM_SESSION, which must satisfy what every wrapped handler may
// read. Only `ctx` is erased — each route's own, handed back unchanged.
type AnyHandler = (req: NextRequest, ctx: unknown, session: SummonarrSession) => Response | Promise<Response>;

interface Store {
  entries: Map<string, Entry>;
  bytes: number;
  /**
   * Bumped by every invalidation (a config write's clear, a removed title's
   * drop). A read that was out across one keeps nothing: its answer may be
   * exactly what the invalidation removed.
   */
  generation: number;
  /** Each wrapped route's own handler (and the ctx Next passed it), by route path. */
  handlers: Map<string, { handler: AnyHandler; ctx: unknown }>;
}

const store = processSingleton<Store>("arr-snapshot:store", () => ({ entries: new Map(), bytes: 0, generation: 0, handlers: new Map() }));

// Views a background re-read is out for, by key. A run that hit its time limit
// stops waiting (its lock is released), but a re-read already started keeps
// going: the next run skips that view instead of asking the arr again.
const refreshing = processSingleton("arr-snapshot:refreshing", () => new Set<string>());

/**
 * The snapshot key of a read, or null when the read is never snapshotted (a
 * background-job poll answers the job, not the page). Query parameters are
 * sorted so `?a=1&b=2` and `?b=2&a=1` are one page; `cached` is the switch
 * itself, not part of what was read.
 */
export function snapshotKey(url: string | URL, locale: string): string | null {
  const u = typeof url === "string" ? new URL(url) : url;
  if (u.searchParams.has("job")) return null;
  const params = [...u.searchParams]
    .filter(([k]) => k !== "cached")
    .sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : av > bv ? 1 : 0) : a < b ? -1 : 1));
  return `${locale}|${u.pathname}?${new URLSearchParams(params).toString()}`;
}

/**
 * What a kept body costs in memory. V8 holds a string with any character past
 * U+00FF (a "•" mask, a dash, a non-Latin title) as two bytes per character,
 * so its UTF-8 length can undercount by up to half. The larger of the two is
 * charged; an ASCII body is charged its length either way.
 */
export function snapshotCharge(body: string, utf8Bytes: number = Buffer.byteLength(body, "utf8")): number {
  return Math.max(utf8Bytes, /[\u0100-\uffff]/.test(body) ? body.length * 2 : body.length);
}

function drop(key: string): void {
  const e = store.entries.get(key);
  if (!e) return;
  store.entries.delete(key);
  store.bytes -= e.bytes;
}

export function rememberSnapshot(
  key: string,
  body: string,
  now: number = Date.now(),
  meta: { url?: string | null; locale?: string | null; viewed?: boolean } = {},
): void {
  const utf8Bytes = Buffer.byteLength(body, "utf8");
  const prev = store.entries.get(key);
  drop(key);
  // The per-answer cap is on the wire size; the total budget is charged in memory.
  if (utf8Bytes > SNAPSHOT_MAX_ENTRY_BYTES) return;
  const bytes = snapshotCharge(body, utf8Bytes);
  // A background refresh is not a view: it keeps the last time an admin looked.
  const viewedAt = meta.viewed === false && prev ? prev.viewedAt : now;
  // Re-inserting puts the key last: Map order is the LRU order.
  store.entries.set(key, {
    body, at: now, bytes, viewedAt,
    url: meta.url ?? prev?.url ?? null,
    locale: meta.locale ?? prev?.locale ?? null,
    failures: 0,
    failedAt: null,
  });
  store.bytes += bytes;
  while (store.bytes > SNAPSHOT_MAX_BYTES) {
    const oldest = store.entries.keys().next().value;
    if (oldest === undefined) break;
    drop(oldest);
  }
}

/** An admin opening a view: answers its snapshot and counts as a view. */
export function readSnapshot(key: string, now: number = Date.now()): { body: string; at: number } | null {
  const e = store.entries.get(key);
  if (!e) return null;
  if (now - e.at > SNAPSHOT_MAX_AGE_MS) {
    drop(key);
    return null;
  }
  e.viewedAt = now;
  store.entries.delete(key);
  store.entries.set(key, e);
  return { body: e.body, at: e.at };
}

/**
 * Drop every snapshot. Called when Radarr/Sonarr configuration changes (an
 * instance added, removed or re-pointed, an integration switched off): a
 * `cached=1` read never runs its route's own instance checks, so without this a
 * removed instance or a switched-off integration would keep painting its last
 * answer for up to SNAPSHOT_MAX_AGE_MS. Also the tests' reset.
 */
export function clearArrSnapshots(): void {
  store.entries.clear();
  store.bytes = 0;
  store.generation++;
}

// The title manager's reads. Each names one title by `service`, `instance` and
// the arr's `id`; the title read can name it by `tmdbId` instead.
const TITLE_READ_PATHS: readonly string[] = [
  "/api/admin/arr/title",
  "/api/admin/arr/title/episodes",
  "/api/admin/arr/title/files",
  "/api/admin/arr/title/history",
];

// An id query value as the routes parse it (parseArrId: digits, leading zeros allowed).
function idParam(v: string | null): number | null {
  return v !== null && /^\d{1,12}$/.test(v) ? Number(v) : null;
}

/**
 * Drop every kept title-manager view of one title on one instance. Called once
 * the title manager's Remove has taken it off the instance: those reads answer
 * 404 from then on, so the background refresh would retry each of them for a
 * day. Returns how many views were dropped.
 */
export function dropArrTitleSnapshots(title: { service: string; instance: string; arrId: number; tmdbId: number | null }): number {
  let dropped = 0;
  for (const key of [...store.entries.keys()]) {
    // The key is `<locale>|<path>?<query>` (snapshotKey).
    const u = new URL(key.slice(key.indexOf("|") + 1), "http://snapshot.invalid");
    const path = routePathOf(u.pathname);
    if (!TITLE_READ_PATHS.includes(path)) continue;
    const q = u.searchParams;
    if (q.get("service") !== title.service || (q.get("instance") ?? "") !== title.instance) continue;
    const byId = idParam(q.get("id")) === title.arrId;
    const byTmdb = path === "/api/admin/arr/title" && title.tmdbId !== null && idParam(q.get("tmdbId")) === title.tmdbId;
    if (!byId && !byTmdb) continue;
    drop(key);
    dropped++;
  }
  if (dropped > 0) store.generation++;
  return dropped;
}

/** Test seam: also forget the registered route handlers. */
export function resetArrSnapshotsForTests(): void {
  clearArrSnapshots();
  store.handlers.clear();
  refreshing.clear();
}

/** A Setting key whose change makes every snapshot suspect (see clearArrSnapshots). */
export function isArrConfigKey(key: string): boolean {
  return /^(radarr|sonarr)/i.test(key) || key === "feature.integration.radarr" || key === "feature.integration.sonarr";
}

/** Test seam: what is held, without touching the LRU order (`bytes` is the memory charge). */
export function arrSnapshotStats(): { entries: number; bytes: number } {
  return { entries: store.entries.size, bytes: store.bytes };
}

/**
 * Wrap an admin arr GET handler (INSIDE its auth wrapper, so the gate runs first):
 * `?cached=1` answers the last snapshot at once (200 + SNAPSHOT_HEADER, or 204
 * when there is none) without calling the handler; any other read runs the
 * handler and keeps its answer when it is a 200 JSON.
 */
export function snapshotted<Ctx, S extends SummonarrSession>(
  handler: (req: NextRequest, ctx: Ctx, session: S) => Response | Promise<Response>,
): (req: NextRequest, ctx: Ctx, session: S) => Promise<Response> {
  return async (req, ctx, session) => {
    const key = snapshotKey(req.url, localeForRequest(req));
    if (new URL(req.url).searchParams.get("cached") === "1") {
      const hit = key ? readSnapshot(key) : null;
      if (!hit) return new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });
      return new NextResponse(hit.body, {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          [SNAPSHOT_HEADER]: new Date(hit.at).toISOString(),
        },
      });
    }
    const generation = store.generation;
    const res = await handler(req, ctx, session);
    if (key) {
      const url = new URL(req.url);
      url.searchParams.delete("cached");
      // Re-run by the background refresh; the latest registration wins (one handler per route).
      store.handlers.set(routePathOf(url.pathname), { handler: handler as unknown as AnyHandler, ctx });
      // Cleared (a config write) or a title dropped while this read was out:
      // its answer may be what that removed, so it is not kept. The live answer
      // itself goes back unchanged.
      if (store.generation === generation) {
        await keepIfJson(key, res, { url: url.toString(), locale: localeForRequest(req), viewed: true });
      }
    }
    return res;
  };
}

async function keepIfJson(key: string, res: Response, meta: { url: string; locale: string; viewed: boolean }, now?: number): Promise<boolean> {
  if (res.status !== 200 || !(res.headers.get("content-type") ?? "").includes("application/json")) return false;
  try {
    rememberSnapshot(key, await res.clone().text(), now ?? Date.now(), meta);
    return true;
  } catch {
    // A body that can't be read twice is simply not kept; the live answer is unaffected.
    return false;
  }
}

// --- background refresh -------------------------------------------------------

// The reads never depend on who asks (only a `job=` poll does, and that is never
// kept), so a refresh runs the handler as the system. Never handed to anything
// but these handlers.
const SYSTEM_SESSION = {
  user: { id: "system:arr-snapshot-refresh", role: "ADMIN", permissions: BigInt(0), name: "Summonarr", email: null },
} satisfies SummonarrSession;

export interface DueSnapshot {
  key: string;
  url: string;
  locale: string;
  everyMs: number;
  /** How far past due (ms); the most overdue go first. */
  overdueMs: number;
  /** Its last background re-read failed. */
  failing: boolean;
}

/** How long a view waits after its last answer, or its last failed re-read. */
function refreshWaitMs(everyMs: number, failures: number): number {
  if (failures <= 0) return everyMs;
  return Math.min(everyMs * 2 ** Math.min(failures - 1, 10), Math.max(everyMs, SNAPSHOT_RETRY_MAX_WAIT_MS));
}

/**
 * The kept views a background run should re-read now: an admin opened it within
 * SNAPSHOT_VIEW_WINDOW_MS, its read has a priority tier, its route's handler is
 * registered in this process, and its answer is at least its tier's interval
 * old (less REFRESH_SLACK_MS). A view whose re-reads keep failing waits from its
 * last attempt instead, the interval doubled per failure in a row up to
 * SNAPSHOT_RETRY_MAX_WAIT_MS, so a dark instance or a removed title is not
 * retried on every run. Healthy views first, by priority then most overdue;
 * failing views last, so their timeouts never take the per-run cap or the run's
 * time from views that answer.
 */
export function dueSnapshots(now: number = Date.now()): DueSnapshot[] {
  const due: DueSnapshot[] = [];
  for (const [key, e] of store.entries) {
    if (!e.url || !e.locale) continue;
    if (now - e.viewedAt > SNAPSHOT_VIEW_WINDOW_MS) continue;
    const path = routePathOf(new URL(e.url).pathname);
    const everyMs = refreshEveryMs(path);
    if (everyMs === null || !store.handlers.has(path)) continue;
    const since = Math.max(e.at, e.failedAt ?? 0);
    const overdueMs = now - since - (refreshWaitMs(everyMs, e.failures) - REFRESH_SLACK_MS);
    if (overdueMs >= 0) due.push({ key, url: e.url, locale: e.locale, everyMs, overdueMs, failing: e.failures > 0 });
  }
  return due.sort((a, b) => Number(a.failing) - Number(b.failing) || a.everyMs - b.everyMs || b.overdueMs - a.overdueMs);
}

// A background re-read of `entry` failed: it waits longer before the next try.
// An answer an admin's own read kept meanwhile is a new entry, left as it is.
function noteFailedRefresh(entry: Entry, at: number): void {
  entry.failures++;
  entry.failedAt = at;
}

export interface RefreshResult {
  /** Views that were due this run. */
  due: number;
  refreshed: number;
  /** Re-reads that answered something other than a 200 JSON, or threw; their last good answer stays. */
  failed: number;
  /** Due views left for the next run (the per-run cap, or the run was stopped). */
  deferred: number;
  aborted: boolean;
}

/**
 * Re-read every due view through its route's own handler and keep what it
 * answers. Observes `signal` before each re-read (guardrail 41): a stopped run
 * starts nothing new and keeps what already landed. Never throws.
 */
export async function refreshArrSnapshots(opts: { signal?: AbortSignal; now?: () => number; maxPerRun?: number } = {}): Promise<RefreshResult> {
  const now = opts.now ?? Date.now;
  const due = dueSnapshots(now()).filter((d) => !refreshing.has(d.key));
  const batch = due.slice(0, opts.maxPerRun ?? SNAPSHOT_REFRESH_MAX_PER_RUN);
  const tally = { refreshed: 0, failed: 0, started: 0 };
  await settleLimit(batch, SNAPSHOT_REFRESH_CONCURRENCY, async (d) => {
    if (opts.signal?.aborted || refreshing.has(d.key)) return;
    // Cleared or replaced since the list was made (a config write, an admin's own read): skip.
    const current = store.entries.get(d.key);
    if (!current || current.url !== d.url) return;
    const reg = store.handlers.get(routePathOf(new URL(d.url).pathname));
    if (!reg) return;
    tally.started++;
    refreshing.add(d.key);
    try {
      const outcome = await refreshOne(d, reg, current, now, opts.signal);
      if (outcome === "refreshed") tally.refreshed++;
      else if (outcome === "failed") tally.failed++;
    } finally {
      refreshing.delete(d.key);
    }
  });
  const aborted = opts.signal?.aborted === true;
  return { due: due.length, refreshed: tally.refreshed, failed: tally.failed, deferred: due.length - tally.started, aborted };
}

// One view re-read through its route's handler. "dropped": the store was
// cleared (or the view removed) while it was out, so its answer is not kept.
async function refreshOne(
  d: DueSnapshot,
  reg: { handler: AnyHandler; ctx: unknown },
  current: Entry,
  now: () => number,
  signal: AbortSignal | undefined,
): Promise<"refreshed" | "failed" | "dropped"> {
  const generation = store.generation;
  try {
    // The run's signal rides on the request, for a handler that observes req.signal.
    const req = new NextRequest(d.url, { headers: { "accept-language": d.locale }, ...(signal ? { signal } : {}) });
    const res = await reg.handler(req, reg.ctx, SYSTEM_SESSION);
    // A config write that cleared the store while this read was out must win
    // — also when an admin's own read has kept the view again since.
    if (store.generation !== generation || !store.entries.has(d.key)) return "dropped";
    if (await keepIfJson(d.key, res, { url: d.url, locale: d.locale, viewed: false }, now())) return "refreshed";
    noteFailedRefresh(store.entries.get(d.key) ?? current, now());
    return "failed";
  } catch (err) {
    // A foreground read may have replaced the entry meanwhile: back off the live one.
    noteFailedRefresh(store.entries.get(d.key) ?? current, now());
    // A route that throws every pass is a condition, not an event (guardrail 7b).
    const path = routePathOf(new URL(d.url).pathname);
    const message = err instanceof Error ? err.message : String(err);
    warnOnChange(`arr-snapshot:${path}`, message, `[arr-snapshot] background re-read of ${path} failed: ${message}`);
    return "failed";
  }
}
