import { NextRequest, NextResponse } from "next/server";
import { isCronAuthorized } from "@/lib/cron-auth";
import { auth, isTokenExpired } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const EXPECTED: Record<string, string[]> = {
  User:                ["id","name","email","passwordHash","role","mediaServer","discordId","autoApprove","quotaExempt"],
  PlexLibraryItem:     ["tmdbId","mediaType","filePath","plexRatingKey","title","year","overview"],
  JellyfinLibraryItem: ["tmdbId","mediaType","filePath","jellyfinItemId","title","year","overview"],
  TVEpisodeCache:      ["source","tmdbId","seasonNumber","episodeNumber"],
  PlayHistory:         ["id","source","tmdbId","mediaType","title","year","posterPath","startedAt","watched"],
  MediaRequest:        ["id","tmdbId","mediaType","title","posterPath","status","requestedBy"],
  TmdbCache:           ["key","data","expiresAt"],
  ActiveSession:       ["id","source","tmdbId","title"],
  MediaServerUser:     ["id","source","sourceUserId","username"],
};

export async function GET(request: NextRequest) {
  // Requires both an admin session AND a cron bearer token to prevent accidental exposure
  const session = await auth();
  if (!session || isTokenExpired(session) || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!(await isCronAuthorized(request))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const rows = await prisma.$queryRaw<{ table_name: string; column_name: string; data_type: string }[]>`
    SELECT table_name, column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
    ORDER BY table_name, ordinal_position
  `;

  const actual: Record<string, string[]> = {};
  for (const row of rows) {
    (actual[row.table_name] ??= []).push(row.column_name);
  }

  const results: Record<string, { ok: boolean; missing: string[]; columns: string[] }> = {};
  for (const [table, expected] of Object.entries(EXPECTED)) {
    const cols    = actual[table] ?? [];
    const missing = expected.filter((c) => !cols.includes(c));
    results[table] = { ok: missing.length === 0, missing, columns: cols };
  }

  const allOk = Object.values(results).every((r) => r.ok);
  return NextResponse.json({ allOk, tables: results, allTables: Object.keys(actual).sort() });
}
