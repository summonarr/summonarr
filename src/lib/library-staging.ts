// The whole-library PlexLibraryItem / JellyfinLibraryItem swap (staged, then
// one short transaction under the source's advisory lock) and the Plex show
// file-path patch. Guardrails 4, 13 and 35.
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma";
import { BATCH_TX_TIMEOUT, CREATE_MANY_BATCH, batchCreateMany, type LibraryTxClient } from "@/lib/batch-write";

/**
 * Advisory lock 2001,1 (PlexLibraryItem) / 2001,2 (JellyfinLibraryItem): every
 * write to a library table serializes on it — the staged swaps below, the
 * Resync routes' recent-only inserts and fix-match's remap. Named here so no
 * writer re-types the pair (a typo would silently stop it serializing). Two
 * LITERAL templates, never an interpolated key: pg_advisory_xact_lock has no
 * (int, bigint) overload, and a fragment in a tagged $executeRaw is guardrail
 * 23a's trap.
 */
export async function lockLibraryInTx(tx: Pick<LibraryTxClient, "$executeRaw">, source: "plex" | "jellyfin"): Promise<void> {
  if (source === "plex") await tx.$executeRaw`SELECT pg_advisory_xact_lock(2001, 1)`;
  else await tx.$executeRaw`SELECT pg_advisory_xact_lock(2001, 2)`;
}

/** One PlexLibraryItem row as the sync writers build it. */
export type PlexLibraryRow = Prisma.PlexLibraryItemCreateManyInput;
/** One JellyfinLibraryItem row as the sync writers build it. */
export type JellyfinLibraryRow = Prisma.JellyfinLibraryItemCreateManyInput;

/** The rows ONE server instance's fetch produced; its slug scopes the delete. */
export interface LibraryInstanceBatch<R> {
  slug: string;
  rows: R[];
}

/**
 * Replace every PlexLibraryItem row of each listed server instance, atomically
 * per run, WITHOUT holding a transaction open for the data transfer — the
 * library twin of replaceEpisodeCacheForSource (episode-cache.ts), and the ONE write path
 * behind both the orchestrator's Plex arm and the admin "Resync Plex" full mode.
 *
 * The shape this replaces was the per-instance `deleteMany` + chunked
 * `createMany` inside ONE interactive transaction under lock 2001,1. On a ~9k
 * title library, with the Jellyfin arm doing the same at the same time and the
 * 5s poller and the cron jobs sharing the pool's 5 connections, the data
 * transfer alone exceeded BATCH_TX_TIMEOUT (observed 32–43s → Prisma P2028)
 * and the write rolled back — on every run, since every run was the same size.
 * Each failing write also pinned a pooled connection for its whole 30s budget,
 * which is what produced "Unable to start a transaction in the given time" in
 * the arr-wanted refresh, the arr-watch monitor and the 5s play-history poller.
 *
 * Now the expensive half runs OUTSIDE any transaction, one statement per chunk,
 * so a pooled connection is handed back between chunks. The transaction holds
 * only the per-instance DELETEs and one INSERT ... SELECT, both server-side,
 * moving no rows over the wire — so its duration tracks the database's own
 * work, not the network or the library size.
 *
 * Atomicity is unchanged (guardrail 13): readers still see either the whole
 * previous set or the whole new one for every instance in the call, because the
 * visible swap is one transaction under the same advisory lock as before. Every
 * delete stays scoped to its own instance (guardrail 35); an instance that is
 * not in `batches` is never touched. A batch with zero rows still clears its
 * instance — a now-empty library is reflected, exactly as the old shape did.
 *
 * Every staged row is stamped with its batch's slug: the delete and the insert
 * must agree on the scope, and that is this helper's contract rather than a
 * property each caller has to get right (a row that escaped its slug used to
 * relocate a named server's library onto the default — see the per-source
 * routes' comments). `runId` scopes the staged rows to THIS call, because the
 * admin Resync routes do not hold the orchestrator's lock 2000 and two
 * concurrent rewrites would otherwise blend their rows in staging.
 */
export async function replacePlexLibraryForInstances(batches: LibraryInstanceBatch<PlexLibraryRow>[]): Promise<void> {
  await replaceLibraryForInstances(batches, {
    staging: prisma.plexLibraryItemStaging,
    lock: (tx) => lockLibraryInTx(tx, "plex"),
    deleteInstance: (tx, slug) => tx.plexLibraryItem.deleteMany({ where: { serverInstance: slug } }),
    insertFromStaging: (tx, runId) => tx.$executeRaw`
      INSERT INTO "PlexLibraryItem" ("tmdbId", "mediaType", "serverInstance", "filePath", "plexRatingKey", "plexRatingKeys", "title", "year", "overview", "contentRating", "addedAt")
      SELECT "tmdbId", "mediaType", "serverInstance", "filePath", "plexRatingKey", "plexRatingKeys", "title", "year", "overview", "contentRating", "addedAt"
      FROM "PlexLibraryItemStaging" WHERE "runId" = ${runId}
    `,
  });
}

/** The Jellyfin twin of replacePlexLibraryForInstances — same rules, lock 2001,2. */
export async function replaceJellyfinLibraryForInstances(batches: LibraryInstanceBatch<JellyfinLibraryRow>[]): Promise<void> {
  await replaceLibraryForInstances(batches, {
    staging: prisma.jellyfinLibraryItemStaging,
    lock: (tx) => lockLibraryInTx(tx, "jellyfin"),
    deleteInstance: (tx, slug) => tx.jellyfinLibraryItem.deleteMany({ where: { serverInstance: slug } }),
    insertFromStaging: (tx, runId) => tx.$executeRaw`
      INSERT INTO "JellyfinLibraryItem" ("tmdbId", "mediaType", "serverInstance", "filePath", "jellyfinItemId", "jellyfinItemIds", "title", "year", "overview", "contentRating", "communityRating", "addedAt")
      SELECT "tmdbId", "mediaType", "serverInstance", "filePath", "jellyfinItemId", "jellyfinItemIds", "title", "year", "overview", "contentRating", "communityRating", "addedAt"
      FROM "JellyfinLibraryItemStaging" WHERE "runId" = ${runId}
    `,
  });
}

/**
 * Staged library rows older than this belong to a run that died before its
 * finally block. The same window as the episode cache's staging sweep.
 */
const LIBRARY_STAGING_SWEEP_MS = 60 * 60_000;

interface LibraryStagingOps<R> {
  staging: {
    createMany: (args: { data: Array<R & { runId: string; serverInstance: string }>; skipDuplicates?: boolean }) => Promise<unknown>;
    deleteMany: (args: { where: { runId?: string; createdAt?: { lt: Date } } }) => Promise<unknown>;
  };
  lock: (tx: LibraryTxClient) => Promise<unknown>;
  deleteInstance: (tx: LibraryTxClient, slug: string) => Promise<unknown>;
  insertFromStaging: (tx: LibraryTxClient, runId: string) => Promise<unknown>;
}

async function replaceLibraryForInstances<R extends { serverInstance?: string }>(
  batches: LibraryInstanceBatch<R>[],
  ops: LibraryStagingOps<R>,
): Promise<void> {
  if (batches.length === 0) return; // nothing to replace — never take the lock for no instance

  const runId = randomUUID();

  // A run killed mid-flight (container restart, lock timeout) leaves its staged
  // rows behind; nothing else would ever collect them. Best-effort so a sweep
  // failure can never block the rewrite it precedes.
  await ops.staging
    .deleteMany({ where: { createdAt: { lt: new Date(Date.now() - LIBRARY_STAGING_SWEEP_MS) } } })
    .catch(() => {});

  try {
    // One chunked load per instance batch (never one concatenated list: a
    // library-sized spread into a call would throw — guardrail 5i), each row
    // stamped with ITS batch's slug and this call's runId.
    for (const { slug, rows } of batches) {
      await batchCreateMany(ops.staging, rows.map((r) => ({ ...r, serverInstance: slug, runId })));
    }

    await prisma.$transaction(async (tx) => {
      await ops.lock(tx);
      // Prisma, not raw SQL: the delete is server-side either way, and keeping it
      // as a model call leaves the per-instance scope visible to the suites that
      // pin "exactly one scoped delete per instance, never an unconditional wipe".
      for (const { slug } of batches) await ops.deleteInstance(tx, slug);
      await ops.insertFromStaging(tx, runId);
    }, { timeout: BATCH_TX_TIMEOUT });
  } finally {
    // Drop this run's staged rows even when the swap threw, so a failed rewrite
    // does not leave a full copy of the library sitting in staging until the sweep.
    await ops.staging.deleteMany({ where: { runId } }).catch(() => {});
  }
}

/**
 * Patch the show file paths the TV walk leaves null (a show item carries no
 * file; the paths come from the type=4 episode listing) onto the
 * just-written PlexLibraryItem rows — ONE statement per CREATE_MANY_BATCH chunk,
 * never one `updateMany` per show.
 *
 * The per-key loop this replaces issued N serialized UPDATE round-trips (N = TV
 * show count) inside one interactive $transaction capped at BATCH_TX_TIMEOUT, on
 * EVERY orchestrator run (the rows were just rewritten null, so its
 * `filePath: null` guard never pruned anything). A multi-thousand-show library
 * burned seconds per run and a large one could hit the timeout, after which
 * every show's path stayed null until the next run repeated the same failure.
 *
 * Kept from the original: the serverInstance scope (ratingKeys are
 * server-local) and the `"filePath" IS NULL` guard, which makes the patch a
 * no-op if a concurrent writer replaced the rows. No wrapping transaction —
 * each chunk is atomic on its own, and a partial patch across chunks is
 * harmless (idempotent, null-scoped, retried next run).
 */
export async function patchPlexShowFilePaths(slug: string, paths: Map<string, string>): Promise<void> {
  const entries = Array.from(paths.entries());
  for (let i = 0; i < entries.length; i += CREATE_MANY_BATCH) {
    const chunk = entries.slice(i, i + CREATE_MANY_BATCH);
    await prisma.$executeRaw(Prisma.sql`
      UPDATE "PlexLibraryItem" AS p
      SET "filePath" = v."file"
      FROM (VALUES ${Prisma.join(chunk.map(([ratingKey, file]) => Prisma.sql`(${ratingKey}::text, ${file}::text)`))}) AS v("ratingKey", "file")
      WHERE p."serverInstance" = ${slug}
        AND p."mediaType" = 'TV'
        AND p."plexRatingKey" = v."ratingKey"
        AND p."filePath" IS NULL
    `);
  }
}
