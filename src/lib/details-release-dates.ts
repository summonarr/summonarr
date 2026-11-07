import "server-only";
import { prisma } from "./prisma";
import { Prisma } from "@/generated/prisma";
import { LIBRARY_PAGE_SIZE } from "./library-iterator";

// The ratings pre-warms need one field of each title's cached TMDB details blob
// (its releaseDate, which picks the ratings row's TTL). Reading the whole blob
// moved and JSON.parsed every stale title's full details just for that, so the
// database extracts the field and sends the key and the date only.
//
// setCache stores JSON.stringify output: no whitespace, and a quote inside a
// string value is escaped, so an unescaped `"releaseDate":"…"` can only be the
// key itself. A regex rather than a `::jsonb` cast because one malformed row
// would fail the cast for the whole page; here it simply reads as null.
const RELEASE_DATE_PATTERN = '"releaseDate":"([^"]*)"';

// details key → its releaseDate (null when absent or unreadable). Keys with no
// cached row are left out of the map.
export async function readDetailsReleaseDates(keys: readonly string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  for (let i = 0; i < keys.length; i += LIBRARY_PAGE_SIZE) {
    const slice = keys.slice(i, i + LIBRARY_PAGE_SIZE);
    // One Prisma.sql value, never a tagged template with a fragment (guardrail 23a).
    const rows = await prisma.$queryRaw<Array<{ key: string; releaseDate: string | null }>>(
      Prisma.sql`SELECT "key", substring("data" from ${RELEASE_DATE_PATTERN}::text) AS "releaseDate" FROM "TmdbCache" WHERE "key" IN (${Prisma.join(slice)})`,
    );
    for (const row of rows) out.set(row.key, row.releaseDate ?? null);
  }
  return out;
}
