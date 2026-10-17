#!/usr/bin/env node
/**
 * E2E seed: insert one ADMIN user so the crawler (scripts/e2e-crawl.mts) can
 * sign in and reach admin-gated routes. Used only by .github/workflows/e2e.yml
 * against a throwaway Postgres service — never run against a real database.
 *
 * Standalone — uses only `pg` and node:crypto, like the migrate-* scripts.
 * Idempotent: re-running refreshes the password hash and role.
 *
 * Usage:
 *   node scripts/e2e-seed.mts
 */

import { Client } from "pg";
import { scrypt as scryptCb, randomBytes, randomUUID } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (
  pw: string,
  salt: Buffer,
  keylen: number,
  opts: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

// >>> password-hash — mirrors hashPassword() in src/lib/password-hash.ts: the
// scrypt:2 format at OWASP's N=2^17, r=8, p=1. tests/password-hash.test.mts runs
// this block and checks its output with the app's own verifyPassword/needsRehash,
// so a drifted copy fails the suite instead of writing a hash sign-in rejects.
const SCRYPT_LN = 17; // N = 2^17
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SCRYPT_SALT_BYTES = 16;
// Node refuses a derivation whose memory (~128·N·r) reaches maxmem.
const SCRYPT_MAXMEM = 2 * 128 * 2 ** SCRYPT_LN * SCRYPT_R;

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const key = await scrypt(password, salt, SCRYPT_KEYLEN, {
    N: 2 ** SCRYPT_LN,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return `scrypt:2:${SCRYPT_LN}:${SCRYPT_R}:${SCRYPT_P}:${salt.toString("base64")}:${key.toString("base64")}`;
}
// <<< password-hash

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
  const email = process.env.E2E_ADMIN_EMAIL || "e2e-admin@summonarr.local";
  const password = process.env.E2E_ADMIN_PASSWORD;
  if (!password) {
    console.error("[e2e-seed] E2E_ADMIN_PASSWORD is required (no default is permitted)");
    process.exit(1);
  }
  const hash = await hashPassword(password);

  const client = new Client(connectionParams());
  await client.connect();
  try {
    await client.query(
      `INSERT INTO "User" (id, email, name, "passwordHash", role, "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5::"Role", now(), now())
       ON CONFLICT (email)
       DO UPDATE SET "passwordHash" = EXCLUDED."passwordHash", role = EXCLUDED.role`,
      [randomUUID(), email, "E2E Admin", hash, "ADMIN"],
    );
    // setup_completed_at suppresses the first-user setup flow and the
    // first-OAuth-user ADMIN auto-promotion (src/lib/auth.ts).
    await client.query(
      `INSERT INTO "Setting" (key, value, "updatedAt")
       VALUES ('setup_completed_at', $1, now())
       ON CONFLICT (key) DO NOTHING`,
      [new Date().toISOString()],
    );
    // Library cleanup is default-OFF (its page 404s), so the crawl would never
    // mount it; switch it on for this throwaway database only.
    await client.query(
      `INSERT INTO "Setting" (key, value, "updatedAt")
       VALUES ('feature.admin.cleanup', 'true', now())
       ON CONFLICT (key) DO NOTHING`,
    );
    console.log(`[e2e-seed] ADMIN user ready: ${email}`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("[e2e-seed]", err);
  process.exit(1);
});
