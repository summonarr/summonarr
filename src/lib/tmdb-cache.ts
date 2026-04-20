import { prisma } from "./prisma";

export const TTL = {
  DETAILS:     7 * 24 * 60 * 60,
  PERSON:      7 * 24 * 60 * 60,
  GENRES:     30 * 24 * 60 * 60,
  DISCOVER:   12 * 60 * 60,
  SEARCH:     12 * 60 * 60,
  ARR_PATHS:   6 * 60 * 60,
} as const;

// Older titles change infrequently; TTL scales with age so fresh releases get updated more aggressively
export function libraryDetailsTtl(releaseDate: string | null | undefined): number {
  const year = releaseDate ? parseInt(releaseDate.substring(0, 4), 10) : NaN;
  const age = isNaN(year) ? Infinity : new Date().getFullYear() - year;
  if (age < 1)  return  3 * 24 * 60 * 60;
  if (age < 3)  return  7 * 24 * 60 * 60;
  if (age < 7)  return 14 * 24 * 60 * 60;
  return              30 * 24 * 60 * 60;
}

// Expired rows are lazily deleted on read rather than via a scheduled job; callers never receive stale data
export async function getCache<T>(key: string): Promise<T | null> {
  const row = await prisma.tmdbCache.findUnique({ where: { key } });
  if (!row) return null;
  if (new Date() > row.expiresAt) {
    prisma.tmdbCache.delete({ where: { key } }).catch(() => {});
    return null;
  }
  try {
    return JSON.parse(row.data) as T;
  } catch {
    return null;
  }
}

// Returns expired entries with isStale=true so callers can serve the old value and revalidate async
export async function getCacheStale<T>(key: string): Promise<{ value: T | null; isStale: boolean }> {
  const row = await prisma.tmdbCache.findUnique({ where: { key } });
  if (!row) return { value: null, isStale: false };
  try {
    return { value: JSON.parse(row.data) as T, isStale: new Date() > row.expiresAt };
  } catch {
    return { value: null, isStale: false };
  }
}

export async function setCache<T>(key: string, data: T, ttlSeconds: number): Promise<void> {
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  const serialised = JSON.stringify(data);
  await prisma.tmdbCache.upsert({
    where: { key },
    update: { data: serialised, cachedAt: new Date(), expiresAt },
    create: { key, data: serialised, cachedAt: new Date(), expiresAt },
  });
}
