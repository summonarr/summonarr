import { prisma } from "./prisma";
import { BATCH_TX_TIMEOUT } from "./batch-write";
import { libraryDetailsTtl } from "./tmdb-cache";
import type { TmdbMedia } from "./tmdb-types";

const LIST_TTL_MS = 12 * 3600 * 1000;

/** The fields a TmdbMediaCore row is written from. */
export type CoreMediaInput = Pick<
  TmdbMedia,
  "id" | "mediaType" | "title" | "posterPath" | "releaseYear" | "voteAverage" | "certification" | "releaseDate"
>;

const toDbMediaType = (m: Pick<TmdbMedia, "mediaType">): "MOVIE" | "TV" => (m.mediaType === "movie" ? "MOVIE" : "TV");

// The columns every writer sets the same way on create AND update. Certification
// and expiresAt are deliberately NOT here: each path has its own rule for them
// (see coreUpsertArgs), and folding them in is how the two drifted before.
const coreColumns = (m: CoreMediaInput) => ({
  title:       m.title,
  posterPath:  m.posterPath  ?? null,
  releaseYear: m.releaseYear || null,
  voteAverage: m.voteAverage ?? 0,
});

// The ONE upsert shape. Certification on update is undefined (skip), NOT null:
// list-shaped TmdbMedia never carries certification, and neither does a leaner
// TMDB fetch, so null here erased the cert a full details fetch or the library
// prewarm stored, blanking the grid badges that read
// TmdbMediaCore.certification. A title genuinely without a cert simply never
// writes one (create keeps the null default).
//
// `updateExpiresAt` false is the list path: an existing row may carry the
// longer age-aware TTL from a details write or the prewarm (3–30 days), and
// overwriting it with the 12h list TTL let the daily purge delete a library
// title's row ~12h after it left the lists. That path EXTENDS expiry separately.
function coreUpsertArgs(m: CoreMediaInput, expiresAt: Date, updateExpiresAt: boolean) {
  const mediaType = toDbMediaType(m);
  return {
    where: { tmdbId_mediaType: { tmdbId: m.id, mediaType } },
    create: {
      tmdbId: m.id,
      mediaType,
      ...coreColumns(m),
      certification: m.certification ?? null,
      expiresAt,
    },
    update: {
      ...coreColumns(m),
      certification: m.certification ?? undefined,
      ...(updateExpiresAt ? { expiresAt } : {}),
      lastSyncedAt: new Date(),
    },
  };
}

// Items are sorted before a batch upsert to prevent deadlocks on concurrent
// transactions that write overlapping sets in different orders.
function sortedForUpsert<T extends Pick<TmdbMedia, "id" | "mediaType">>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => a.id - b.id || a.mediaType.localeCompare(b.mediaType));
}

// Failures are thrown, not logged: every caller logs them once under its own
// scope (tmdb.ts, the prewarm), and logging here too printed each one twice.
export async function syncTmdbMediaCore(items: TmdbMedia[]): Promise<void> {
  if (!items.length) return;
  const expiresAt = new Date(Date.now() + LIST_TTL_MS);
  const sorted = sortedForUpsert(items);
  await prisma.$transaction(
    [
      ...sorted.map((m) => prisma.tmdbMediaCore.upsert(coreUpsertArgs(m, expiresAt, false))),
      // Runs after the upserts, so every row it touches is already locked by
      // this transaction in sorted order — it acquires no new locks. It only
      // ever EXTENDS expiry (GREATEST semantics).
      prisma.tmdbMediaCore.updateMany({
        where: {
          expiresAt: { lt: expiresAt },
          OR: sorted.map((m) => ({ tmdbId: m.id, mediaType: toDbMediaType(m) })),
        },
        data: { expiresAt },
      }),
    ],
    { timeout: BATCH_TX_TIMEOUT },
  );
}

// The age-aware TTL rather than the fixed list TTL, so library items aren't
// re-fetched sooner than they need to be.
const detailsExpiry = (m: CoreMediaInput) => new Date(Date.now() + libraryDetailsTtl(m.releaseDate) * 1000);

// Single-item upsert used after fetching a full detail page.
export async function upsertTmdbMediaCore(media: CoreMediaInput): Promise<void> {
  await prisma.tmdbMediaCore.upsert(coreUpsertArgs(media, detailsExpiry(media), true));
}

// upsertTmdbMediaCore for many titles in ONE transaction (sorted, like
// syncTmdbMediaCore), each with its own age-aware TTL: one round trip for a
// prewarm page's backfill instead of one per row. All or nothing.
export async function upsertTmdbMediaCoreMany(items: readonly CoreMediaInput[]): Promise<void> {
  if (!items.length) return;
  await prisma.$transaction(
    sortedForUpsert(items).map((m) => prisma.tmdbMediaCore.upsert(coreUpsertArgs(m, detailsExpiry(m), true))),
    { timeout: BATCH_TX_TIMEOUT },
  );
}
