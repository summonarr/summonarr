import { prisma } from "./prisma";
import { check, type Schema } from "./validate";

export const TTL = {
  DETAILS:     7 * 24 * 60 * 60,
  PERSON:      7 * 24 * 60 * 60,
  GENRES:     30 * 24 * 60 * 60,
  DISCOVER:   12 * 60 * 60,
  SEARCH:     12 * 60 * 60,
  ARR_PATHS:   6 * 60 * 60,
} as const;

// Older titles change rarely, so the cache TTL grows with a title's age;
// new releases are refreshed more often.
export function libraryDetailsTtl(releaseDate: string | null | undefined): number {
  const year = releaseDate ? parseInt(releaseDate.substring(0, 4), 10) : NaN;
  const age = isNaN(year) ? Infinity : new Date().getFullYear() - year;
  if (age < 1)  return  3 * 24 * 60 * 60;
  if (age < 3)  return  7 * 24 * 60 * 60;
  if (age < 7)  return 14 * 24 * 60 * 60;
  return              30 * 24 * 60 * 60;
}

// ── Key shapes ──────────────────────────────────────────────────────────────

const DETAILS_SUFFIX = ":details";

/**
 * The key of a title's normalized TmdbMedia blob: `movie:<id>:details` /
 * `tv:<id>:details`. Accepts the DB enum or the TMDB media type. English only,
 * never a language segment (guardrail 40a).
 */
export function tmdbDetailsKey(mediaType: "MOVIE" | "TV" | "movie" | "tv", id: number): string {
  return `${mediaType === "MOVIE" || mediaType === "movie" ? "movie" : "tv"}:${id}${DETAILS_SUFFIX}`;
}

// Namespaces whose expired rows stay readable for a grace period: the ratings
// rows and the `:details` blobs are read through getCacheStale/getCacheStaleMany
// (the admin dashboard, the prewarm carry-forward, the ratings pipeline), so the
// /api/sync purge reaps them on their own grace and the lazy delete below leaves
// them alone. `:tmdb:` is load-bearing (bare `mdblist:`/`omdb:` also match the
// list caches), and `:details` is matched as a SUFFIX so credits, suggestions,
// seasons and the `:details:missing` tombstones still expire immediately.
export const SERVE_STALE_RATINGS_PREFIXES = ["mdblist:tmdb:", "omdb:tmdb:"] as const;
const DETAILS_MEDIA_PREFIXES = ["movie:", "tv:"] as const;

/** The purge's `where` shapes for the same namespaces (sync/route.ts). */
export const SERVE_STALE_RATINGS_WHERE = SERVE_STALE_RATINGS_PREFIXES.map((p) => ({ key: { startsWith: p } }));
export const SERVE_STALE_DETAILS_WHERE = DETAILS_MEDIA_PREFIXES.map((p) => ({ key: { startsWith: p, endsWith: DETAILS_SUFFIX } }));

export function isServeStaleKey(key: string): boolean {
  return SERVE_STALE_RATINGS_PREFIXES.some((p) => key.startsWith(p))
    || DETAILS_MEDIA_PREFIXES.some((p) => key.startsWith(p) && key.endsWith(DETAILS_SUFFIX));
}

// ── Reads ───────────────────────────────────────────────────────────────────
//
// Every read takes an optional `schema` (validate.ts). Given one, a row whose
// JSON doesn't match it is a miss, exactly like unparseable JSON — so a stub
// another writer stored under the same key, or a blob from an older shape,
// never reaches the caller typed as T. Without one the value is returned as
// stored (the existing callers' contract).

type CachedParse<T> = { ok: true; value: T } | { ok: false };

function parseCached<T>(data: string, schema: Schema<T> | undefined): CachedParse<T> {
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return { ok: false };
  }
  if (!schema) return { ok: true, value: raw as T };
  const checked = check(schema, raw);
  return checked.ok ? { ok: true, value: checked.value as T } : { ok: false };
}

/**
 * A live row's value WITH its expiry, or null for a missing, expired or
 * unparseable row. For a read-then-upgrade-in-place caller that must not extend
 * the row's life (setCacheUntil).
 */
export async function getCacheEntry<T>(key: string, schema?: Schema<T>): Promise<{ value: T; expiresAt: Date } | null> {
  const row = await prisma.tmdbCache.findUnique({ where: { key } });
  if (!row) return null;
  if (new Date() > row.expiresAt) {
    // deleteMany with an expiresAt guard: if a concurrent setCache just refreshed
    // this key, the new row is not expired and is left alone. A serve-stale row
    // is kept for its stale readers (the purge reaps it after its grace).
    if (!isServeStaleKey(key)) {
      prisma.tmdbCache.deleteMany({ where: { key, expiresAt: { lt: new Date() } } }).catch(() => {});
    }
    return null;
  }
  const parsed = parseCached(row.data, schema);
  return parsed.ok ? { value: parsed.value, expiresAt: row.expiresAt } : null;
}

// Returns null for a missing, expired or unparseable row, so callers never get
// stale data. An expired row is also deleted here in the background, except in
// the serve-stale namespaces above (the /api/sync run purges any that are never
// read again).
export async function getCache<T>(key: string, schema?: Schema<T>): Promise<T | null> {
  return (await getCacheEntry<T>(key, schema))?.value ?? null;
}

// Batch variant of getCache — one findMany instead of N sequential point reads
// (the tvdb→tmdb resolver hits this on every sync run). Same semantics as
// getCache: expired rows are misses and are lazily deleted (serve-stale
// namespaces excepted), malformed JSON is a miss.
export async function getCacheMany<T>(keys: readonly string[], schema?: Schema<T>): Promise<Map<string, T>> {
  const out = new Map<string, T>();
  if (keys.length === 0) return out;
  const rows = await prisma.tmdbCache.findMany({ where: { key: { in: [...keys] } } });
  const now = new Date();
  const expired: string[] = [];
  for (const row of rows) {
    if (now > row.expiresAt) {
      if (!isServeStaleKey(row.key)) expired.push(row.key);
      continue;
    }
    // malformed rows are misses, same as getCache
    const parsed = parseCached(row.data, schema);
    if (parsed.ok) out.set(row.key, parsed.value);
  }
  if (expired.length > 0) {
    // expiresAt guard so a concurrent setCache upsert isn't clobbered by stale-read cleanup
    prisma.tmdbCache.deleteMany({ where: { key: { in: expired }, expiresAt: { lt: new Date() } } }).catch(() => {});
  }
  return out;
}

// Stale-while-revalidate read: an expired row is still returned, flagged
// isStale=true, so the caller can show the old value and refresh it in the background.
export async function getCacheStale<T>(key: string, schema?: Schema<T>): Promise<{ value: T | null; isStale: boolean }> {
  const row = await prisma.tmdbCache.findUnique({ where: { key } });
  if (!row) return { value: null, isStale: false };
  const parsed = parseCached(row.data, schema);
  return parsed.ok ? { value: parsed.value, isStale: new Date() > row.expiresAt } : { value: null, isStale: false };
}

// Batch variant of getCacheStale — one findMany instead of N point reads. Same
// semantics: expired rows are served with isStale=true (never deleted);
// missing/unparseable keys are absent from the map (the `{ value: null }` case).
export async function getCacheStaleMany<T>(
  keys: readonly string[],
  schema?: Schema<T>,
): Promise<Map<string, { value: T; isStale: boolean }>> {
  const out = new Map<string, { value: T; isStale: boolean }>();
  if (keys.length === 0) return out;
  const rows = await prisma.tmdbCache.findMany({ where: { key: { in: [...keys] } } });
  const now = new Date();
  for (const row of rows) {
    // malformed rows are misses, same as getCacheStale
    const parsed = parseCached(row.data, schema);
    if (parsed.ok) out.set(row.key, { value: parsed.value, isStale: now > row.expiresAt });
  }
  return out;
}

// Upsert a JSON-serialised value under `key`, valid for `ttlSeconds`.
export async function setCache<T>(key: string, data: T, ttlSeconds: number): Promise<void> {
  await setCacheUntil(key, data, new Date(Date.now() + ttlSeconds * 1000));
}

// Upsert a JSON-serialised value under `key`, valid until `expiresAt` — an
// in-place upgrade of a row read through getCacheEntry keeps the row's own expiry.
export async function setCacheUntil<T>(key: string, data: T, expiresAt: Date): Promise<void> {
  const serialised = JSON.stringify(data);
  await prisma.tmdbCache.upsert({
    where: { key },
    update: { data: serialised, cachedAt: new Date(), expiresAt },
    create: { key, data: serialised, cachedAt: new Date(), expiresAt },
  });
}
