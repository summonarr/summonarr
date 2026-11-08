// The media servers' OWN watch records — the snapshot job (guardrail 14d's
// evidence 5). Reads Plex's all-account watch history and every Jellyfin user's
// played/resumable items, folds them into per-title rows, and replaces this
// server's UpstreamWatchEvidence snapshot. The never-watched report and the
// cleanup rules read those rows as READ-ONLY evidence that a title WAS watched —
// catching plays from before Summonarr was installed, while it was down, or
// while tracking was off. The pure half (parsers, aggregation, agreement) and
// the UNVERIFIED upstream shapes are in upstream-watch.ts.
//
// Rules:
// - NEVER writes PlayHistory or ActiveSession (guardrail 19 — the live poller is
//   the sole history writer). The only writes are this server's evidence rows
//   and its status Setting.
// - Every server is isolated: one failing never stops or affects another.
// - A snapshot is written ONLY after a complete, successful fetch: a scoped
//   deleteMany + batchCreateMany inside ONE transaction (guardrails 4/13/35),
//   which also writes the snapshot's status — upstreamHealth judges the rows by
//   it and the cleanup holds titles back on it, so new rows never sit beside an
//   old status (or the reverse): both commit, or neither does. A
//   failed or aborted server keeps its previous rows — a partial snapshot would
//   silently DROP evidence, and dropped evidence is how a watched title ends up
//   offered for deletion. The one partial read that IS written is a Plex history
//   that reached its read cap (every record it holds is real), and it is stored
//   `truncated` — health "incomplete", never "ok" — so the cleanup still holds
//   back what its dropped OLDEST records might have proved watched.
// - A self-check makes a broken parser loud instead of silent: `matched` (how
//   many rows land on a library title) and the AGREEMENT between the server's
//   records and the plays Summonarr itself recorded as completed. Both feed
//   upstreamHealth(), which the report shows beside every server.
// - Observes the AbortSignal between servers, between Jellyfin users and while
//   paging, and RETURNS on abort (guardrail 41).
// - Each server is cut off inside a RUN BUDGET below the lock's 30-minute work
//   timeout. A server that runs out is recorded FAILED ("timed out") and keeps
//   its previous snapshot, and the run moves on: one slow server must not blow
//   the lock (which the entrypoint answers by retrying the whole walk every few
//   minutes) or starve the servers after it. The budget is NOT pre-split evenly:
//   a server may use everything left minus a small RESERVE held for each server
//   after it (UPSTREAM_SERVER_RESERVE_MS). An even split capped the first server
//   (always Plex) at a fraction of the run, so a big history that finished in
//   15 minutes failed every day while the servers after it took seconds.
// - A NAMED server removed while its refresh is in flight writes NOTHING after
//   the removal: the snapshot's transaction (evidence and status) and a failed
//   server's status write each lock the registry row (FOR UPDATE) and re-check
//   the slug is still listed (stillRegisteredInTx). The removal (/api/admin/media-instances) writes that
//   row first in its own transaction, so the two are ordered either way — a
//   removal that commits first is seen and skipped; a refresh that commits
//   first is deleted by the removal. Otherwise a server registered later under
//   the same slug would inherit this one's evidence and "ok" status (14d).
import { prisma, type PrismaTxClient } from "./prisma";
import { BATCH_TX_TIMEOUT, batchCreateMany } from "./batch-write";
import { mapLimit } from "./concurrency";
import { forgetWarnOnChange, warnOnChange } from "./log-dedup";
import { describeTxFailure } from "./tx-diagnostics";
import { getMediaInstances, getSyncableMediaInstances, registeredSlugsForUpdateInTx } from "./media-instance-registry";
import { DEFAULT_MEDIA_INSTANCE, mediaInstanceLabel } from "./media-instances";
import { getPlexConfig } from "./plex-config";
import { getJellyfinConfig } from "./jellyfin-config";
import { getPlexWatchHistory } from "./plex";
import { getJellyfinAllUsers, getJellyfinUserPlayedItems } from "./jellyfin";
import { parseUpstreamStatus, upstreamStatusKey } from "./never-watched-data";
import {
  isUnhealthyUpstreamCheck,
  upstreamEpisodesUnplaced,
  upstreamHealth,
  type NwSource,
  type NwUpstreamHealth,
  type NwUpstreamStatus,
} from "./never-watched";
import {
  aggregateUpstream,
  agreementSince,
  computeAgreement,
  earliestViewed,
  safeUpstreamError,
  UPSTREAM_ERROR_TEXT,
  type JellyfinPlayedItem,
  type UpstreamEvidenceRow,
} from "./upstream-watch";

// Jellyfin users read at once (guardrail 31): each is two sequential page walks.
const JELLYFIN_USER_CONCURRENCY = 3;

// The whole run's budget, kept below withAdvisoryLock's 30-minute work timeout
// (advisory-lock.ts) so a slow server is cut short HERE — recorded failed, the
// run still answering 200 — instead of the lock expiring under it (non-2xx →
// the entrypoint's 5-minute retry, every later server unreached).
export const UPSTREAM_RUN_BUDGET_MS = 25 * 60_000;

// The time held back for EACH server still to come when one starts: what it may
// spend is the rest of the budget minus this per later server. Generous for a
// typical Jellyfin walk or a skipped (unconfigured) server, and whatever a server
// leaves unused flows on to the next. A small budget scales it down
// (upstreamServerReserve).
export const UPSTREAM_SERVER_RESERVE_MS = 3 * 60_000;

// The reserve per later server for a run of `servers` servers: the constant,
// but never more than half the run spread over them, so the first server always
// gets at least half of the budget.
export function upstreamServerReserve(runBudgetMs: number, servers: number): number {
  if (servers <= 1) return 0;
  return Math.min(UPSTREAM_SERVER_RESERVE_MS, Math.floor(runBudgetMs / (2 * servers)));
}

// What server `index` (0-based) of `servers` may spend when `remainingMs` of the
// run is left: everything except the reserve for each server after it.
export function upstreamServerShare(remainingMs: number, index: number, servers: number, reserveMs: number): number {
  return Math.max(0, Math.floor(remainingMs - reserveMs * (servers - index - 1)));
}

// A server's share of the run budget ran out. What its fetch returned is a
// PARTIAL walk (the page readers stop on the signal rather than throw), and a
// partial snapshot drops evidence — so it is never written.
class UpstreamBudgetError extends Error {
  name = "UpstreamBudgetError";
}

// A server whose answer holds no records at all while Summonarr itself recorded
// completed plays there: a degraded read (a truncating proxy, a de-elevated
// token, a changed shape that parses to nothing), never "nobody watched
// anything" — replacing the previous snapshot with it would drop every row.
class UpstreamEmptyAnswerError extends Error {
  name = "UpstreamEmptyAnswerError";
}

// A failure in Summonarr's OWN database work for a server (the self-check reads,
// the snapshot transaction) — logged as such, so an admin isn't sent to debug a
// media server that answered fine. The stored status keeps the closed
// vocabulary ("request failed"): the page has no words for a database error.
class UpstreamStoreError extends Error {
  name = "UpstreamStoreError";
  readonly cause: unknown;
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.cause = cause;
  }
}

async function inStorePhase<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    throw new UpstreamStoreError(err);
  }
}

export interface UpstreamServerResult {
  source: NwSource;
  instance: string;
  // This run's fetch succeeded and its snapshot was written.
  ok: boolean;
  // The stored status after this run (on a failure: the PREVIOUS snapshot's).
  entries: number;
  matched: number;
  samples: number;
  agreed: number;
  error: string | null;
  health: NwUpstreamHealth;
}

export interface UpstreamRefreshResult {
  servers: UpstreamServerResult[];
  // The run stopped on its AbortSignal; the server in progress was not written.
  aborted: boolean;
}

// Servers that failed, or whose snapshot the self-check refuses (failed /
// unreliable / incomplete) — the count the cron route degrades the run on.
export function upstreamRefreshProblems(result: UpstreamRefreshResult): number {
  return result.servers.filter((s) => !s.ok || isUnhealthyUpstreamCheck(s)).length;
}

interface Snapshot {
  // Watch records the server returned (status `entries`).
  records: number;
  rows: UpstreamEvidenceRow[];
  // The items' OWN keys (movie / episode), for the agreement check.
  rawItemKeys: Set<string>;
  // How far back the fetched records reach (Plex); null = no floor.
  floor: Date | null;
  // The read stopped at its cap; the oldest records were not read.
  truncated: boolean;
  // Episode records, and those with no show id — counted from the PARSED
  // records, before aggregation (which silently skips an unplaced episode).
  episodeRecords: number;
  unplacedEpisodes: number;
}

function episodeCounts(items: Iterable<{ kind: string; showKey: string | null }>): { episodeRecords: number; unplacedEpisodes: number } {
  let episodeRecords = 0;
  let unplacedEpisodes = 0;
  for (const it of items) {
    if (it.kind !== "episode") continue;
    episodeRecords++;
    if (!it.showKey) unplacedEpisodes++;
  }
  return { episodeRecords, unplacedEpisodes };
}

type FetchOutcome = Snapshot | "unconfigured";

async function plexSnapshot(slug: string, signal: AbortSignal | undefined, maxItems: number | undefined): Promise<FetchOutcome> {
  const cfg = await getPlexConfig(slug);
  const url = cfg.url?.trim();
  const token = cfg.token?.trim();
  if (!url || !token) return "unconfigured";
  const history = await getPlexWatchHistory(url, token, maxItems === undefined ? { signal } : { signal, maxItems });
  // A truncated history is logged once by logHealth (its "incomplete" health).
  return {
    records: history.records,
    rows: aggregateUpstream(history.entries),
    rawItemKeys: new Set(history.entries.map((e) => e.itemKey)),
    floor: earliestViewed(history.entries),
    truncated: history.truncated,
    ...episodeCounts(history.entries),
  };
}


// The same item in both lists (played, and now being re-watched) is ONE item for
// that user: the larger play count and the later date.
function mergeUserItem(prev: JellyfinPlayedItem, next: JellyfinPlayedItem): JellyfinPlayedItem {
  const later = next.lastPlayedAt && (!prev.lastPlayedAt || next.lastPlayedAt > prev.lastPlayedAt) ? next.lastPlayedAt : prev.lastPlayedAt;
  return { ...prev, playCount: Math.max(prev.playCount, next.playCount), lastPlayedAt: later };
}

async function jellyfinSnapshot(slug: string, signal: AbortSignal | undefined): Promise<FetchOutcome> {
  const cfg = await getJellyfinConfig(slug);
  const url = cfg.url?.trim();
  const apiKey = cfg.apiKey?.trim();
  if (!url || !apiKey) return "unconfigured";

  const users = await getJellyfinAllUsers(url, apiKey, { signal });
  // A server always has at least its admin. An empty 200 is a degraded read (a
  // de-elevated key, a truncating proxy) — writing it would wipe every user's
  // evidence (the guardrail-28 trap), so it is a failure.
  if (users.length === 0) throw new Error("Jellyfin returned no users");

  // One user failing fails the server (a snapshot missing a user drops their
  // evidence), and stops the others promptly instead of letting them run on.
  const abortOthers = new AbortController();
  const stop = signal ? AbortSignal.any([signal, abortOthers.signal]) : abortOthers.signal;
  let failed = false;
  let failure: unknown = null;
  let records = 0;
  const items: JellyfinPlayedItem[] = [];
  await mapLimit(users, JELLYFIN_USER_CONCURRENCY, async (user) => {
    if (stop.aborted) return;
    try {
      const byItem = new Map<string, JellyfinPlayedItem>();
      for (const filter of ["IsPlayed", "IsResumable"] as const) {
        if (stop.aborted) return;
        const res = await getJellyfinUserPlayedItems(url, apiKey, user.id, filter, { signal: stop });
        records += res.records;
        for (const it of res.items) {
          const prev = byItem.get(it.itemKey);
          byItem.set(it.itemKey, prev ? mergeUserItem(prev, it) : it);
        }
      }
      // A loop, not push(...spread): a user with a six-figure played list would
      // exceed the engine's argument limit and fail the whole server.
      if (!stop.aborted) for (const it of byItem.values()) items.push(it);
    } catch (err) {
      if (!failed) {
        failed = true;
        failure = err;
      }
      abortOthers.abort();
    }
  });
  if (failed) throw failure;
  return {
    records,
    rows: aggregateUpstream(items),
    rawItemKeys: new Set(items.map((i) => i.itemKey)),
    // Played flags are current state, not a dated log: no floor.
    floor: null,
    // Every page is read: a user's walk that can't finish fails the server.
    truncated: false,
    ...episodeCounts(items),
  };
}

// Evidence keys looked up per library query. Two lists of this size bind
// 10,000 parameters, well under Postgres's 32,766 (guardrail 23c).
const MATCH_KEY_CHUNK = 5_000;

// Rows whose key lands on a library title of THIS server — both key columns
// (guardrails 37/37c: the singular canonical key OR any duplicate copy's key).
// Only the library rows holding one of the evidence keys are read, in chunks,
// never the whole library.
async function countMatched(source: NwSource, slug: string, rows: UpstreamEvidenceRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const keys = [...new Set(rows.map((r) => r.itemKey))];
  const movies = new Set<string>();
  const shows = new Set<string>();
  const collect = (mediaType: string, held: Array<string | null>) => {
    const target = mediaType === "MOVIE" ? movies : mediaType === "TV" ? shows : null;
    if (target) for (const k of held) if (k) target.add(k);
  };
  for (let i = 0; i < keys.length; i += MATCH_KEY_CHUNK) {
    const chunk = keys.slice(i, i + MATCH_KEY_CHUNK);
    if (source === "plex") {
      const found = await prisma.plexLibraryItem.findMany({
        where: { serverInstance: slug, OR: [{ plexRatingKey: { in: chunk } }, { plexRatingKeys: { hasSome: chunk } }] },
        select: { mediaType: true, plexRatingKey: true, plexRatingKeys: true },
      });
      for (const r of found) collect(r.mediaType, [r.plexRatingKey, ...(r.plexRatingKeys ?? [])]);
    } else {
      const found = await prisma.jellyfinLibraryItem.findMany({
        where: { serverInstance: slug, OR: [{ jellyfinItemId: { in: chunk } }, { jellyfinItemIds: { hasSome: chunk } }] },
        select: { mediaType: true, jellyfinItemId: true, jellyfinItemIds: true },
      });
      for (const r of found) collect(r.mediaType, [r.jellyfinItemId, ...(r.jellyfinItemIds ?? [])]);
    }
  }
  return rows.filter((r) => (r.mediaType === "MOVIE" ? movies : shows).has(r.itemKey)).length;
}

// Items Summonarr itself recorded as fully watched on this server since `since`.
async function recordedItemKeys(source: NwSource, slug: string, since: Date): Promise<Set<string>> {
  const rows = await prisma.playHistory.findMany({
    where: { source, serverInstance: slug, completed: true, startedAt: { gte: since }, sourceItemId: { not: null } },
    select: { sourceItemId: true },
    distinct: ["sourceItemId"],
  });
  const keys = new Set<string>();
  for (const r of rows) if (r.sourceItemId) keys.add(r.sourceItemId);
  return keys;
}

async function readStatus(source: NwSource, slug: string): Promise<NwUpstreamStatus | null> {
  try {
    const row = await prisma.setting.findUnique({ where: { key: upstreamStatusKey(source, slug) } });
    return parseUpstreamStatus(row?.value);
  } catch {
    return null;
  }
}

// Whether a NAMED instance is still registered, read with its service's registry
// row LOCKED, so a concurrent removal (which writes that row first, in the same
// transaction as its cleanup) is ordered against this write. The default
// instance is synthesized and can never be removed. A missing or unreadable
// registry lists nothing.
async function stillRegisteredInTx(tx: PrismaTxClient, source: NwSource, slug: string): Promise<boolean> {
  if (slug === DEFAULT_MEDIA_INSTANCE) return true;
  return (await registeredSlugsForUpdateInTx(tx, source)).has(slug);
}

// A FAILED server's status (a success's commits with its snapshot, in
// refreshServer). Never throws: the previous rows are kept either way, and a
// failed write must not abort the servers after it. A named server is written
// only while still registered (the header's removal rule); the default's write
// is the plain upsert it always was.
async function writeStatus(source: NwSource, slug: string, status: NwUpstreamStatus): Promise<void> {
  const key = upstreamStatusKey(source, slug);
  const value = JSON.stringify(status);
  try {
    if (slug === DEFAULT_MEDIA_INSTANCE) {
      await prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
    } else {
      // Guardrail 23: nothing caught in here — a failure propagates out of the
      // transaction to the catch below.
      await prisma.$transaction(async (tx) => {
        if (!(await stillRegisteredInTx(tx, source, slug))) return;
        await tx.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
      });
    }
  } catch (err) {
    console.warn(
      `[upstream-watch] ${mediaInstanceLabel(source, slug)}: could not record the refresh status:`,
      err instanceof Error ? err.message : err,
    );
  }
}

function resultOf(source: NwSource, slug: string, status: NwUpstreamStatus, now: Date): UpstreamServerResult {
  return {
    source,
    instance: slug,
    ok: status.ok,
    entries: status.entries,
    matched: status.matched,
    samples: status.samples,
    agreed: status.agreed,
    error: status.error,
    health: upstreamHealth(status, now),
  };
}

// What is wrong with a server this run, as a repeat-suppression state and its
// log line; null = healthy. upstreamHealth already decided failed / unreliable /
// incomplete; this only names WHY a "failed" snapshot failed.
function healthCondition(
  label: string,
  result: UpstreamServerResult,
  status: NwUpstreamStatus,
  failure: unknown,
): { state: string; message: string } | null {
  const prefix = `[upstream-watch] ${label}:`;
  if (!result.ok && failure instanceof UpstreamStoreError) {
    const { kind, text } = describeTxFailure(failure.cause, { txTimeoutMs: BATCH_TX_TIMEOUT });
    return {
      state: `store-failed|${kind}`,
      message: `${prefix} the server answered, but storing its snapshot in Summonarr's database failed (${text}); keeping the previous snapshot`,
    };
  }
  if (!result.ok) {
    return {
      state: `failed|${result.error ?? ""}`,
      message: `${prefix} could not read the server's own watch records (${result.error ?? "unknown error"}); keeping the previous snapshot`,
    };
  }
  switch (result.health) {
    case "failed":
      // Records that match nothing at all are the broader fault: name that
      // one even when most episodes are unplaced too.
      return upstreamEpisodesUnplaced(status) && !(status.entries > 0 && status.matched === 0)
        ? { state: "unplaced-episodes", message: `${prefix} most episode records carry no show id, so TV evidence can't be placed on a title — the response shape may have changed` }
        : { state: "unmatched", message: `${prefix} the server returned watch records but none matched a library title — its response shape may have changed` };
    case "unreliable":
      return { state: "unreliable", message: `${prefix} fewer than half of the items Summonarr recorded as watched appear in the server's own watch records — they may be misread or incomplete` };
    case "incomplete":
      return { state: "incomplete", message: `${prefix} watch history is longer than the read cap; only the most recent records were read, so its titles stay held back from cleanup` };
    default:
      return null;
  }
}

// An unhealthy server is a CONDITION recomputed every run — repeat-suppressed
// (guardrail 7b), and forgotten once it clears so a recurrence logs again.
function logHealth(source: NwSource, slug: string, result: UpstreamServerResult, status: NwUpstreamStatus, failure: unknown): void {
  const label = mediaInstanceLabel(source, slug);
  const key = `upstream-watch:${label}`;
  const condition = healthCondition(label, result, status, failure);
  if (condition) warnOnChange(key, condition.state, condition.message);
  else forgetWarnOnChange(key);
}

type ServerOutcome = UpstreamServerResult | "skipped" | "aborted";

// The failure text a status row records — client-safe (safeUpstreamError), with
// our own two refusals named.
// The words come from UPSTREAM_ERROR_TEXT, so the page can translate them back
// to a code (upstreamErrorCode).
function failureText(err: unknown): string {
  if (err instanceof UpstreamBudgetError) return UPSTREAM_ERROR_TEXT.timeout;
  if (err instanceof UpstreamEmptyAnswerError) return UPSTREAM_ERROR_TEXT.noRecords;
  if (err instanceof UpstreamStoreError) return UPSTREAM_ERROR_TEXT.other;
  return safeUpstreamError(err);
}

interface SelfCheck {
  matched: number;
  samples: number;
  agreed: number;
}

// The snapshot's self-check (header): how many rows land on a library title,
// and how many of Summonarr's own recent completed plays the server reports.
async function selfCheck(source: NwSource, slug: string, snapshot: Snapshot, now: Date): Promise<SelfCheck> {
  const matched = await countMatched(source, slug, snapshot.rows);
  const recorded = await recordedItemKeys(source, slug, agreementSince(now, snapshot.floor));
  return { matched, ...computeAgreement(recorded, snapshot.rawItemKeys) };
}

function freshStatus(snapshot: Snapshot, check: SelfCheck, now: Date): NwUpstreamStatus {
  return {
    fetchedAt: now.toISOString(),
    attemptedAt: now.toISOString(),
    ok: true,
    entries: snapshot.records,
    matched: check.matched,
    samples: check.samples,
    agreed: check.agreed,
    error: null,
    truncated: snapshot.truncated,
    episodeRecords: snapshot.episodeRecords,
    unplacedEpisodes: snapshot.unplacedEpisodes,
  };
}

// Replace this server's evidence and write its status, in ONE transaction under
// the registry lock. False = the server was removed while it was being read,
// and nothing was written (header).
async function writeSnapshot(source: NwSource, slug: string, rows: UpstreamEvidenceRow[], status: NwUpstreamStatus, now: Date): Promise<boolean> {
  const statusKey = upstreamStatusKey(source, slug);
  const statusValue = JSON.stringify(status);
  // Guardrails 23/23c: each write awaited in turn, nothing caught in here — a
  // failed status write rolls the evidence replace back with it, and the
  // server is recorded failed, its previous rows and status kept.
  return prisma.$transaction(
    async (tx) => {
      if (!(await stillRegisteredInTx(tx, source, slug))) return false;
      await tx.upstreamWatchEvidence.deleteMany({ where: { source, serverInstance: slug } });
      await batchCreateMany(
        tx.upstreamWatchEvidence,
        rows.map((r) => ({
          source,
          serverInstance: slug,
          itemKey: r.itemKey,
          seasonNumber: r.seasonNumber,
          mediaType: r.mediaType,
          playCount: r.playCount,
          lastPlayedAt: r.lastPlayedAt,
          fetchedAt: now,
        })),
      );
      await tx.setting.upsert({ where: { key: statusKey }, create: { key: statusKey, value: statusValue }, update: { value: statusValue } });
      return true;
    },
    { timeout: BATCH_TX_TIMEOUT },
  );
}

// A failed server's status: this attempt's error over the PREVIOUS snapshot's
// facts, which stay true because its rows are kept.
async function failedStatus(source: NwSource, slug: string, err: unknown, now: Date): Promise<NwUpstreamStatus> {
  const prev = await readStatus(source, slug);
  return {
    fetchedAt: prev?.fetchedAt ?? null,
    attemptedAt: now.toISOString(),
    ok: false,
    entries: prev?.entries ?? 0,
    matched: prev?.matched ?? 0,
    samples: prev?.samples ?? 0,
    agreed: prev?.agreed ?? 0,
    error: failureText(err),
    truncated: prev?.truncated ?? false,
    episodeRecords: prev?.episodeRecords ?? 0,
    unplacedEpisodes: prev?.unplacedEpisodes ?? 0,
  };
}

// `signal` is the LOCK's (guardrail 41: aborted → write nothing, return);
// `serverSignal` also fires when this server's share of the run budget runs out
// (→ a failed server, and the run goes on).
async function refreshServer(
  source: NwSource,
  slug: string,
  signal: AbortSignal | undefined,
  serverSignal: AbortSignal,
  fetchSnapshot: (signal: AbortSignal) => Promise<FetchOutcome>,
): Promise<ServerOutcome> {
  const now = new Date();
  let status: NwUpstreamStatus;
  let failure: unknown = null;
  try {
    const snapshot = await fetchSnapshot(serverSignal);
    if (snapshot === "unconfigured") return "skipped";
    // The lock first: a lock abort also fires serverSignal, and must stay an
    // abort (nothing written, no later server), not a "timed out" server.
    if (signal?.aborted) return "aborted";
    if (serverSignal.aborted) throw new UpstreamBudgetError(`${mediaInstanceLabel(source, slug)}: out of run budget`);
    const check = await inStorePhase(() => selfCheck(source, slug, snapshot, now));
    // Last check before the write: an aborted run writes nothing for the
    // server in progress (guardrail 41).
    if (signal?.aborted) return "aborted";
    // Nothing at all from a server Summonarr saw completed plays on: keep the
    // previous snapshot rather than replace it with nothing (upstreamHealth
    // reads such a status as unreliable too, should one ever be stored).
    if (snapshot.records === 0 && check.samples > 0) {
      throw new UpstreamEmptyAnswerError(`${mediaInstanceLabel(source, slug)}: no watch records`);
    }
    const fresh = freshStatus(snapshot, check, now);
    if (!(await inStorePhase(() => writeSnapshot(source, slug, snapshot.rows, fresh, now)))) return "skipped";
    status = fresh;
  } catch (err) {
    if (signal?.aborted) return "aborted";
    failure = err;
    status = await failedStatus(source, slug, err, now);
    await writeStatus(source, slug, status);
  }
  const result = resultOf(source, slug, status, now);
  logHealth(source, slug, result, status, failure);
  return result;
}

// `runBudgetMs` and `plexMaxItems` are test seams; production always runs on
// UPSTREAM_RUN_BUDGET_MS and getPlexWatchHistory's own read cap.
export async function refreshUpstreamWatch(
  { signal, runBudgetMs = UPSTREAM_RUN_BUDGET_MS, plexMaxItems }: { signal?: AbortSignal; runBudgetMs?: number; plexMaxItems?: number } = {},
): Promise<UpstreamRefreshResult> {
  const servers: UpstreamServerResult[] = [];
  if (signal?.aborted) return { servers, aborted: true };
  const deadline = Date.now() + runBudgetMs;

  // Plex: the registry + getPlexConfig's findUnique reads and a skip-if-
  // unconfigured, never getSyncableMediaInstances (guardrail 35's Plex note).
  // Both lists are read up front so every server's share of the budget is known.
  const plan: Array<{ source: NwSource; slug: string }> = [
    ...(await getMediaInstances("plex")).map((i) => ({ source: "plex" as const, slug: i.slug })),
    ...(await getSyncableMediaInstances("jellyfin")).map((i) => ({ source: "jellyfin" as const, slug: i.slug })),
  ];

  const reserve = upstreamServerReserve(runBudgetMs, plan.length);
  for (let i = 0; i < plan.length; i++) {
    if (signal?.aborted) return { servers, aborted: true };
    const { source, slug } = plan[i];
    // Everything LEFT minus a reserve per later server, recomputed per server:
    // a slow server takes from the tail, never from a pre-split even share, and
    // a fast (or skipped) server hands its unused time to the ones after it.
    const share = upstreamServerShare(deadline - Date.now(), i, plan.length, reserve);
    const budget = AbortSignal.timeout(share);
    const serverSignal = signal ? AbortSignal.any([signal, budget]) : budget;
    const outcome = await refreshServer(source, slug, signal, serverSignal, (s) =>
      source === "plex" ? plexSnapshot(slug, s, plexMaxItems) : jellyfinSnapshot(slug, s),
    );
    if (outcome === "aborted") return { servers, aborted: true };
    if (outcome !== "skipped") servers.push(outcome);
  }
  return { servers, aborted: false };
}
