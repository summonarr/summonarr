#!/usr/bin/env node
// One-shot migration: account for any remaining bcrypt (`$2`-prefixed) rows in
// User.passwordHash before the bcryptjs dependency is removed.
//
// The credentials provider auto-rehashes legacy hashes to scrypt on successful
// login, so this only matters for accounts that have not signed in since the
// scrypt cutover landed in commit 62f0a62.
//
// Default mode reports the count and lists affected users. `--nullify` clears
// the column for those users, which forces them through the password-reset
// flow on next login. Once this script reports zero rows (or you have run
// --nullify), the bcrypt verify branch in src/lib/password-hash.ts and the
// bcryptjs npm dep are safe to delete.
//
// Standalone — uses only `pg`. Mirrors the pattern in
// scripts/migrate-webhook-secrets.mjs.
//
// Usage:
//   docker compose cp scripts/migrate-legacy-passwords.mjs summonarr:/app/scripts/
//   docker compose exec -w /app summonarr node scripts/migrate-legacy-passwords.mjs
//   docker compose exec -w /app summonarr node scripts/migrate-legacy-passwords.mjs --nullify
//
// Idempotent — running it twice is harmless.

import { Client } from "pg";

function parseArgs(argv) {
  const opts = { nullify: false };
  for (const arg of argv) {
    if (arg === "--nullify") opts.nullify = true;
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node scripts/migrate-legacy-passwords.mjs [--nullify]");
      process.exit(0);
    }
  }
  return opts;
}

function connectionParams() {
  if (process.env.PGHOST && process.env.PGUSER && process.env.PGPASSWORD && process.env.PGDATABASE) {
    return {
      user: process.env.PGUSER,
      password: process.env.PGPASSWORD,
      host: process.env.PGHOST,
      port: process.env.PGPORT ? parseInt(process.env.PGPORT, 10) : 5432,
      database: process.env.PGDATABASE,
    };
  }
  if (process.env.DATABASE_URL) {
    const m = process.env.DATABASE_URL.match(
      /^postgres(?:ql)?:\/\/([^:]+):(.+)@([^:/]+)(?::(\d+))?\/([^?]+)/
    );
    if (!m) throw new Error("Cannot parse DATABASE_URL");
    const [, user, password, host, port, database] = m;
    return { user, password, host, port: port ? parseInt(port, 10) : 5432, database };
  }
  throw new Error("Set DATABASE_URL or PGHOST/PGUSER/PGPASSWORD/PGDATABASE");
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const client = new Client(connectionParams());
  await client.connect();
  try {
    const { rows } = await client.query(
      `SELECT id, email, role
         FROM "User"
        WHERE "passwordHash" LIKE '$2%'
        ORDER BY role DESC, email ASC`,
    );

    if (rows.length === 0) {
      console.log("No legacy bcrypt passwordHash rows found — safe to drop bcryptjs.");
      return;
    }

    console.log(`Found ${rows.length} user(s) with a legacy bcrypt passwordHash:`);
    for (const r of rows) {
      console.log(`  - ${r.email}  (${r.role})  [id: ${r.id}]`);
    }

    if (!opts.nullify) {
      console.log("");
      console.log("Options:");
      console.log("  1. Have each listed user sign in once — the credentials provider");
      console.log("     will auto-rehash their password to scrypt.");
      console.log("  2. Re-run with --nullify to clear passwordHash for these rows;");
      console.log("     affected users must then reset their password to sign in.");
      console.log("");
      console.log("Do NOT remove the bcryptjs dependency while this list is non-empty.");
      process.exitCode = 1;
      return;
    }

    const ids = rows.map((r) => r.id);
    const update = await client.query(
      `UPDATE "User"
          SET "passwordHash" = NULL,
              "passwordChangedAt" = NOW()
        WHERE id = ANY($1::text[])
          AND "passwordHash" LIKE '$2%'`,
      [ids],
    );
    console.log("");
    console.log(`Nullified ${update.rowCount} legacy passwordHash row(s).`);
    console.log("Affected users must use the password-reset flow on next sign-in.");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
