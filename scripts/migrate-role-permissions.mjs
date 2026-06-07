#!/usr/bin/env node
// One-shot migration: seed the new User.permissions bitmask from the legacy
// role + autoApprove + quotaExempt columns. Run ONCE per environment, right
// after `prisma db push` adds the `permissions` column (default 0).
//
// Idempotent — only writes rows where permissions = 0 (the default), so a second
// run is a no-op and it won't clobber masks an admin has hand-edited. Users
// deliberately set to permissions = 0 fall back to their role preset at runtime
// (see effectivePermissions in src/lib/permissions.ts), so leaving them 0 is
// safe too — this migration just makes the stored value match the legacy intent.
//
// Standalone — uses only `pg`. No Prisma, no crypto (permissions aren't secret).
// Mirrors scripts/migrate-webhook-secrets.mjs.
//
// Bit values MUST match src/lib/permissions.ts:
//   ADMIN=1, MANAGE_USERS=2, MANAGE_REQUESTS=4, MANAGE_ISSUES=8,
//   REQUEST=16, REQUEST_MOVIE=32, REQUEST_TV=64,
//   AUTO_APPROVE=128, ... QUOTA_UNLIMITED=2048
// Presets: USER = 16|32|64 = 112; ISSUE_ADMIN = 112|8 = 120; ADMIN = 1.
//
// Usage:
//   docker compose cp scripts/migrate-role-permissions.mjs summonarr:/app/scripts/
//   docker compose exec -w /app summonarr node scripts/migrate-role-permissions.mjs

import { Client } from "pg";

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
      /^postgres(?:ql)?:\/\/([^:]+):(.+)@([^:/]+)(?::(\d+))?\/([^?]+)/
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
    // Single atomic UPDATE. Bits are disjoint so `|` (bitwise OR) composes the
    // role preset with the AUTO_APPROVE / QUOTA_UNLIMITED bits.
    const res = await client.query(`
      UPDATE "User"
      SET permissions =
        (CASE role
           WHEN 'ADMIN' THEN 1
           WHEN 'ISSUE_ADMIN' THEN 120
           ELSE 112
         END)
        | (CASE WHEN "autoApprove" THEN 128 ELSE 0 END)
        | (CASE WHEN "quotaExempt" THEN 2048 ELSE 0 END)
      WHERE permissions = 0
    `);

    console.log(`Seeded permissions for ${res.rowCount} user(s).`);
    if (res.rowCount === 0) {
      console.log("Nothing to do — every user already has a non-zero permission mask.");
    } else {
      console.log("Done. Legacy role/autoApprove/quotaExempt have been folded into the bitmask.");
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
