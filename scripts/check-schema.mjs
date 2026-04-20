// Run with: node scripts/check-schema.mjs
// Requires DATABASE_URL in environment (same as the app).

import "dotenv/config";
import pg from "pg";

const { Client } = pg;

const EXPECTED = {
  User:               ["id","name","email","passwordHash","role","mediaServer","discordId","autoApprove","quotaExempt"],
  PlexLibraryItem:    ["tmdbId","mediaType","filePath","plexRatingKey","title","year","overview"],
  JellyfinLibraryItem:["tmdbId","mediaType","filePath","jellyfinItemId","title","year","overview"],
  TVEpisodeCache:     ["source","tmdbId","seasonNumber","episodeNumber"],
  PlayHistory:        ["id","source","tmdbId","mediaType","title","year","posterPath","startedAt","watched"],
  MediaRequest:       ["id","tmdbId","mediaType","title","posterPath","status","requestedBy"],
  TmdbCache:          ["key","data","expiresAt"],
  ActiveSession:      ["id","source","tmdbId","title"],
  MediaServerUser:    ["id","source","sourceUserId","username"],
};

const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const { rows } = await client.query(`
  SELECT table_name, column_name
  FROM information_schema.columns
  WHERE table_schema = 'public'
  ORDER BY table_name, ordinal_position
`);

const actual = {};
for (const row of rows) {
  (actual[row.table_name] ??= []).push(row.column_name);
}

let allOk = true;
for (const [table, cols] of Object.entries(EXPECTED)) {
  const actualCols = actual[table] ?? [];
  const missing    = cols.filter(c => !actualCols.includes(c));
  const status     = missing.length === 0 ? "✓" : "✗ MISSING";
  console.log(`${status}  ${table}${missing.length ? " — missing: " + missing.join(", ") : ""}`);
  if (missing.length) allOk = false;
}

console.log("\nAll tables:");
for (const [t, cols] of Object.entries(actual).sort()) {
  console.log(`  ${t} (${cols.length} cols): ${cols.join(", ")}`);
}

await client.end();
process.exit(allOk ? 0 : 1);
