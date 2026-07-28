#!/usr/bin/env node
// Add the new `serverInstance String` slug column across all five affected
// models (multi-server Plex/Jellyfin support). Every existing row lands on ""
// (the default server) via the column default — there is no legacy
// discriminator to interpret, unlike the is4k→arrInstance migration.
//
// ────────────────────────────────────────────────────────────────────────────
// DOCKER USERS DO NOT NEED THIS — the container entrypoint runs the identical
// migration automatically before every `prisma db push`. This script is only
// for NON-Docker / manual `prisma db push` deployments.
// ────────────────────────────────────────────────────────────────────────────
//
// The migration is NON-DESTRUCTIVE and purely additive: `prisma db push` only
// has to swap the PK/unique keys onto an already-populated column, which lands
// as the auto-safe "unique constraint" / "primary key will be changed"
// warnings, never a destructive column drop. If you push first, db push fails
// LOUDLY on a key collision (23505) and leaves the DB untouched — no silent
// data loss — then run this and retry the push.
//
// Idempotent — ADD COLUMN IF NOT EXISTS. Safe to re-run.
//
// Standalone — uses only `pg`. No Prisma, no crypto (serverInstance is not
// secret). Mirrors scripts/migrate-is4k-to-arrinstance.mjs.
//
// Usage (non-Docker):
//   node scripts/migrate-media-server-instance.mjs   # then: prisma db push

import { Client } from "pg";

// Every model that gained the serverInstance discriminator.
const TABLES = [
  "PlexLibraryItem",
  "JellyfinLibraryItem",
  "MediaServerUser",
  "PlayHistory",
  "ActiveSession",
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
      const hasServerInstance = await columnExists(client, table, "serverInstance");
      if (hasServerInstance) {
        console.log(`[${table}] serverInstance already present — nothing to do`);
        continue;
      }
      await client.query(
        `ALTER TABLE "${table}" ADD COLUMN "serverInstance" TEXT NOT NULL DEFAULT ''`,
      );
      console.log(`[${table}] added serverInstance column (every existing row defaults to the "" server)`);
    }

    console.log(
      "\nDone. serverInstance is populated. Now run `prisma db push` (or redeploy) to swap the keys onto it.",
    );
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
