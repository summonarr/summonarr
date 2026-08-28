import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { isCronAuthorized } from "@/lib/cron-auth";
import { prisma } from "@/lib/prisma";

// Tracks the columns whose ABSENCE means a `db push` was skipped or refused —
// in particular the multi-instance identity columns (guardrails 32/35), which
// sit inside @@id/@@unique keys, so every scoped write fails at runtime when
// they are missing while a pre-instance column list would still report allOk.
const EXPECTED: Record<string, string[]> = {
  User:                ["id","name","email","passwordHash","role","permissions","mediaServer","discordId","autoApprove","quotaExempt","deactivatedAt","purgedAt"],
  PlexLibraryItem:     ["tmdbId","mediaType","serverInstance","filePath","plexRatingKey","title","year","overview"],
  JellyfinLibraryItem: ["tmdbId","mediaType","serverInstance","filePath","jellyfinItemId","jellyfinItemIds","title","year","overview"],
  TVEpisodeCache:      ["source","tmdbId","seasonNumber","episodeNumber"],
  PlayHistory:         ["id","source","serverInstance","tmdbId","mediaType","title","year","posterPath","startedAt","watched"],
  MediaRequest:        ["id","tmdbId","mediaType","arrInstance","title","posterPath","status","requestedBy"],
  TmdbCache:           ["key","data","expiresAt"],
  ActiveSession:       ["id","source","serverInstance","tmdbId","title"],
  MediaServerUser:     ["id","source","serverInstance","sourceUserId","username"],
  RadarrWantedItem:    ["tmdbId","arrInstance"],
  SonarrWantedItem:    ["tmdbId","arrInstance"],
  RadarrAvailableItem: ["tmdbId","arrInstance"],
  SonarrAvailableItem: ["tmdbId","arrInstance"],
};

// Requires both an admin session (withAdmin) AND a cron bearer token to
// prevent accidental exposure — the inline isCronAuthorized check stays.
export const GET = withAdmin(async (request, _ctx, _session) => {
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
});
