#!/usr/bin/env node
// Backfill the new `arrInstance String` slug from the legacy `is4k Boolean`
// discriminator across all six models (multi-instance Radarr/Sonarr support).
// false → "" (the default instance), true → "4k".
//
// ────────────────────────────────────────────────────────────────────────────
// DOCKER USERS DO NOT NEED THIS — the container entrypoint runs the identical
// backfill automatically before every `prisma db push`. This script is only for
// NON-Docker / manual `prisma db push` deployments.
// ────────────────────────────────────────────────────────────────────────────
//
// The migration is NON-DESTRUCTIVE: `is4k` is RETAINED in the schema (deprecated),
// so `prisma db push` never drops a column — it only swaps the PK/unique keys onto
// the `arrInstance` column this script populates. Run this BEFORE `prisma db push`
// so those key swaps land collision-free. If you push first, db push fails LOUDLY
// on a key collision (23505) and leaves the DB untouched — no silent data loss —
// then run this and retry the push. The four Radarr/Sonarr cache tables self-heal
// (fully replaced every sync) so their backfill is a convenience.
//
// Idempotent — ADD COLUMN IF NOT EXISTS + only backfills rows still at "". Safe to
// re-run; a run after a future release drops is4k is a clean no-op.
//
// Standalone — uses only `pg`. No Prisma, no crypto (arrInstance is not secret).
// Mirrors scripts/migrate-role-permissions.mjs.
//
// Usage (non-Docker):
//   node scripts/migrate-is4k-to-arrinstance.mjs   # then: prisma db push

import { Client } from "pg";

// Every model that carried the `is4k` discriminator.
const TABLES = [
  "MediaRequest",
  "RadarrWantedItem",
  "RadarrAvailableItem",
  "SonarrWantedItem",
  "SonarrAvailableItem",
  "TrashApplication",
];

async function columnExists(client, table, column) {
  const res = await client.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
    [table, column],
  );
  return res.rowCount > 0;
}

async function main() {
  let user, password, host, port, database;
  if (process.env.PGHOST && process.env.PGUSER && process.env.PGPASSWORD && process.env.PGDATABASE) {
    user = process.env.PGUSER;
    password = process.env.PGPASSWORD;
    host = process.env.PGHOST;
    port = process.env.PGPORT ? parseInt(process.env.PGPORT, 10) : 5432;
    database = process.env.PGDATABASE;
  } else if (process.env.DATABASE_URL) {
    const m = process.env.DATABASE_URL.match(
      /^postgres(?:ql)?:\/\/([^:]+):(.+)@([^:/]+)(?::(\d+))?\/([^?]+)/,
    );
    if (!m) throw new Error("Cannot parse DATABASE_URL");
    [, user, password, host, port, database] = m;
    port = port ? parseInt(port, 10) : 5432;
  } else {
    throw new Error("Set DATABASE_URL or PGHOST/PGUSER/PGPASSWORD/PGDATABASE");
  }

  const client = new Client({ user, password, host, port, database });
  await client.connect();

  try {
    for (const table of TABLES) {
      const hasArrInstance = await columnExists(client, table, "arrInstance");
      if (!hasArrInstance) {
        // Add the new column with the same default the schema declares, so db
        // push sees it as already-present and doesn't try to (re)create it.
        await client.query(
          `ALTER TABLE "${table}" ADD COLUMN "arrInstance" TEXT NOT NULL DEFAULT ''`,
        );
        console.log(`[${table}] added arrInstance column`);
      }

      const hasIs4k = await columnExists(client, table, "is4k");
      if (!hasIs4k) {
        console.log(`[${table}] is4k already dropped — nothing to backfill`);
        continue;
      }

      const res = await client.query(
        `UPDATE "${table}" SET "arrInstance" = '4k' WHERE "is4k" = true AND "arrInstance" = ''`,
      );
      console.log(`[${table}] backfilled ${res.rowCount} row(s) to arrInstance='4k'`);
    }

    console.log(
      "\nDone. arrInstance is populated. Now run `prisma db push` (or redeploy) to swap the keys onto it (is4k is retained, deprecated).",
    );
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
