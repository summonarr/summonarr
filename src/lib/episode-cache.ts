// The TVEpisodeCache whole-source rewrite: a staged swap that skips an
// unchanged set by comparing digests (guardrails 4, 13 and 35).
import { createHash, randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma";
import { warnOnChange, forgetWarnOnChange } from "@/lib/log-dedup";
import { BATCH_TX_TIMEOUT, batchCreateMany } from "@/lib/batch-write";

/** One episode row as the sync arms build it — the source column is added here. */
export interface EpisodeCacheRow {
  tmdbId: number;
  seasonNumber: number;
  episodeNumber: number;
  episodeName?: string | null;
  airDate?: string | null;
  stillPath?: string | null;
  runtime?: number | null;
  overview?: string | null;
  addedAt?: Date | null;
}

/**
 * Several servers of one source can hold the same episode. The staging insert
 * skips duplicates (first row wins), which would keep whichever server's
 * `addedAt` happened to come first; the never-watched report dates a season by
 * the EARLIEST arrival, so carry that onto the surviving row. Every other field
 * keeps the first row's value, exactly as before.
 */
export function earliestAddedPerEpisode<T extends EpisodeCacheRow>(rows: T[]): T[] {
  const byKey = new Map<string, T>();
  for (const r of rows) {
    const key = `${r.tmdbId}:${r.seasonNumber}:${r.episodeNumber}`;
    const prev = byKey.get(key);
    if (!prev) byKey.set(key, r);
    else if (r.addedAt && (!prev.addedAt || r.addedAt < prev.addedAt)) byKey.set(key, { ...prev, addedAt: r.addedAt });
  }
  return byKey.size === rows.length ? rows : [...byKey.values()];
}

/** Staged rows older than this belong to a run that died before its finally block. */
const EPISODE_STAGING_SWEEP_MS = 60 * 60_000;

/**
 * One episode row as text, field by field, for the unchanged-set check below.
 * MUST produce, character for character, what EPISODE_ROW_TEXT_SQL produces for
 * the same row once stored — tests/db/episode-cache-digest.test.mts proves the
 * two agree on a real Postgres. Text fields are length-prefixed in UTF-8 bytes
 * (Postgres `octet_length`) so no value can run into the next field, and `-`
 * stands for null (an empty string is `0:`). A disagreement here can only cost
 * the skip, never correctness: a mismatch means "rewrite", which is the old
 * behaviour.
 */
function episodeRowText(r: EpisodeCacheRow): string {
  const text = (v: string | null | undefined) => (v == null ? "-" : `${Buffer.byteLength(v, "utf8")}:${v}`);
  const added = r.addedAt == null ? "-" : String(new Date(r.addedAt).getTime());
  return [
    String(r.tmdbId),
    String(r.seasonNumber),
    String(r.episodeNumber),
    text(r.episodeName),
    text(r.airDate),
    text(r.stillPath),
    r.runtime == null ? "-" : String(r.runtime),
    text(r.overview),
    added,
  ].join("|");
}

/**
 * The SQL twin of episodeRowText, over a stored TVEpisodeCache row. Covers every
 * column the swap's INSERT ... SELECT writes except `source`, which the WHERE
 * fixes. A column added to the swap must be added here and to episodeRowText,
 * or a change in it alone would read as "unchanged" —
 * tests/episode-cache-swap.test.mts fails when the lists drift.
 * `addedAt` is timestamp(3), so epoch × 1000 is the exact JS getTime().
 */
const EPISODE_ROW_TEXT_SQL = Prisma.sql`
  "tmdbId"::text || '|' || "seasonNumber"::text || '|' || "episodeNumber"::text
  || '|' || coalesce(octet_length("episodeName")::text || ':' || "episodeName", '-')
  || '|' || coalesce(octet_length("airDate")::text || ':' || "airDate", '-')
  || '|' || coalesce(octet_length("stillPath")::text || ':' || "stillPath", '-')
  || '|' || coalesce("runtime"::text, '-')
  || '|' || coalesce(octet_length("overview")::text || ':' || "overview", '-')
  || '|' || coalesce(round(extract(epoch from "addedAt") * 1000)::bigint::text, '-')
`;

/** Row count plus an order-independent digest of an episode set (null when empty). */
export interface EpisodeCacheDigest {
  rows: number;
  digest: string | null;
}

/**
 * Digest of the rows a rewrite would store: md5 of each row's text, sorted, then
 * md5 of the concatenation. Sorting makes it independent of row order; the hex
 * digests sort the same in JS and under `COLLATE "C"`. Pass rows AFTER
 * earliestAddedPerEpisode — that is the set the swap writes.
 */
export function episodeCacheDigest(rows: readonly EpisodeCacheRow[]): EpisodeCacheDigest {
  if (rows.length === 0) return { rows: 0, digest: null };
  const hashes = rows.map((r) => createHash("md5").update(episodeRowText(r), "utf8").digest("hex"));
  hashes.sort();
  return { rows: rows.length, digest: createHash("md5").update(hashes.join(""), "utf8").digest("hex") };
}

/**
 * The same digest, computed by Postgres over what the table holds for `source`
 * now. Read-only: one pass over the source's rows, no writes.
 */
async function storedEpisodeCacheDigest(source: "plex" | "jellyfin"): Promise<EpisodeCacheDigest | null> {
  const result = await prisma.$queryRaw<Array<{ rows: unknown; digest: unknown }>>(Prisma.sql`
    SELECT count(*)::int AS "rows",
           md5(string_agg(h, '' ORDER BY h COLLATE "C")) AS "digest"
    FROM (
      SELECT md5(${EPISODE_ROW_TEXT_SQL}) AS h
      FROM "TVEpisodeCache"
      WHERE "source" = ${source}
    ) t
  `);
  const row = Array.isArray(result) ? result[0] : undefined;
  if (!row || typeof row.rows !== "number") return null;
  if (row.digest !== null && typeof row.digest !== "string") return null;
  return { rows: row.rows, digest: row.digest };
}

/**
 * True only when the table already holds exactly `rows` for `source`, so the
 * rewrite would change nothing. Every doubt answers false — the caller then
 * rewrites, as it always did. A failed comparison is warned once per change of
 * error (guardrail 7b): it would otherwise recur on every sync and silently
 * turn the skip off.
 */
async function episodeCacheUnchanged(source: "plex" | "jellyfin", rows: readonly EpisodeCacheRow[]): Promise<boolean> {
  const key = `episode-cache-digest:${source}`;
  let stored: EpisodeCacheDigest | null;
  try {
    stored = await storedEpisodeCacheDigest(source);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnOnChange(key, msg, `[episode-cache] could not compare the stored ${source} episodes, rewriting them: ${msg}`);
    return false;
  }
  forgetWarnOnChange(key);
  if (!stored) return false;
  const fresh = episodeCacheDigest(rows);
  return stored.rows === fresh.rows && stored.digest === fresh.digest;
}

/**
 * Replace every TVEpisodeCache row for one source, atomically, WITHOUT holding a
 * transaction open for the data transfer.
 *
 * The shape this replaces was `deleteMany` + chunked `createMany` inside ONE
 * interactive transaction. That pushes the entire episode set over the wire with
 * the transaction open, so its cost grows with the library: on a large one it
 * exceeded the 30s budget (observed 35,689ms → Prisma P2028), the transaction
 * rolled back, and the episode cache silently stopped updating — permanently,
 * because every later run failed at the same size. It also pinned one of the
 * pool's 5 connections for those 35s, which is what produced "Unable to start a
 * transaction in the given time" in the 5s play-history poller (guardrail 19's
 * sole writer of Jellyfin history).
 *
 * Now the expensive half runs OUTSIDE any transaction, one statement per chunk,
 * so a pooled connection is handed back between chunks. The transaction holds
 * only a DELETE and an INSERT ... SELECT, both server-side, moving no rows over
 * the wire — so its duration tracks the database's own work, not the network.
 *
 * Atomicity is unchanged, which guardrail 35 requires: readers still see either
 * the whole previous set or the whole new one, never a partial union, because
 * the visible swap is one transaction under the same advisory lock as before.
 *
 * `runId` scopes the staged rows to THIS call. Concurrent whole-table rewrites
 * of one source are reachable (the hourly orchestrator holds lock 2000, but the
 * admin "Resync" routes do not take it), and without the scope they would mix
 * their rows in staging and swap across a blend of both.
 *
 * An UNCHANGED set is not rewritten (returns "unchanged"). A Plex timeline event
 * starts a full sync, so on a busy server this ran several times an hour, each
 * time staging, swapping and un-staging every episode of the source (~75k rows
 * per source on a large library, observed 2026-11) to land the same contents.
 * The check compares this call's rows with what the table holds now, computed
 * by Postgres, so it holds no matter who wrote the table last (fix-match, the
 * season page's TMDB refresh, the Jellyfin recent-only path, a restore): it
 * skips only when the swap would leave every row byte-identical. It runs before
 * the swap's lock, as the fetch that produced `rows` always did; a write that
 * lands in between is ordered as if it came after this sync.
 */
export async function replaceEpisodeCacheForSource(
  source: "plex" | "jellyfin",
  rows: EpisodeCacheRow[],
): Promise<"replaced" | "unchanged"> {
  const runId = randomUUID();

  // A run killed mid-flight (container restart, lock timeout) leaves its staged
  // rows behind; nothing else would ever collect them. Best-effort so a sweep
  // failure can never block the rewrite it precedes.
  await prisma.tVEpisodeCacheStaging
    .deleteMany({ where: { createdAt: { lt: new Date(Date.now() - EPISODE_STAGING_SWEEP_MS) } } })
    .catch(() => {});

  const toWrite = earliestAddedPerEpisode(rows);
  if (await episodeCacheUnchanged(source, toWrite)) return "unchanged";

  try {
    await batchCreateMany(
      prisma.tVEpisodeCacheStaging,
      toWrite.map((r) => ({ ...r, runId, source })),
    );

    await prisma.$transaction(async (tx) => {
      // Same lock ids the per-source routes take (2002,1 plex / 2002,2 jellyfin),
      // as literals: pg_advisory_xact_lock has no (int, bigint) overload, so a
      // parameterised objId fails to resolve the function.
      if (source === "plex") await tx.$executeRaw`SELECT pg_advisory_xact_lock(2002, 1)`;
      else await tx.$executeRaw`SELECT pg_advisory_xact_lock(2002, 2)`;
      // Prisma, not raw SQL: the delete is server-side either way, and keeping it
      // as a model call leaves the whole-namespace replace visible to the suites
      // that pin "exactly one delete, scoped to this source".
      await tx.tVEpisodeCache.deleteMany({ where: { source } });
      await tx.$executeRaw`
        INSERT INTO "TVEpisodeCache" ("source", "tmdbId", "seasonNumber", "episodeNumber", "episodeName", "airDate", "stillPath", "runtime", "overview", "addedAt")
        SELECT "source", "tmdbId", "seasonNumber", "episodeNumber", "episodeName", "airDate", "stillPath", "runtime", "overview", "addedAt"
        FROM "TVEpisodeCacheStaging" WHERE "runId" = ${runId}
      `;
    }, { timeout: BATCH_TX_TIMEOUT });
  } finally {
    // Drop this run's staged rows even when the swap threw, so a failed rewrite
    // does not leave a full copy of the library sitting in staging until the sweep.
    await prisma.tVEpisodeCacheStaging.deleteMany({ where: { runId } }).catch(() => {});
  }
  return "replaced";
}
