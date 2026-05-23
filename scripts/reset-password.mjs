#!/usr/bin/env node
// Force-reset a local-credentials user's password from the host or container.
// Useful when a local admin is locked out (forgotten password, OAuth-only
// account that needs a fallback, recovery after a botched provider config).
//
// Updates User.passwordHash with a fresh scrypt hash and sets passwordChangedAt
// to NOW(), which invalidates every existing JWT for that user — they will
// have to sign in again on every device.
//
// Standalone — uses only `pg` and node:crypto. Mirrors the scrypt parameters
// in src/lib/password-hash.ts; keep them in sync.
//
// Usage (the script ships inside the image at /app/scripts/reset-password.mjs):
//   docker compose exec -w /app summonarr \
//     node scripts/reset-password.mjs user@example.com 'new-password'
//
//   # Or against the host DB:
//   DATABASE_URL=postgres://... node scripts/reset-password.mjs user@example.com 'new-password'
//
//   # Promote to ADMIN at the same time (no-op if already ADMIN):
//   docker compose exec -w /app summonarr \
//     node scripts/reset-password.mjs user@example.com 'new-password' --admin
//
//   # Read the password from stdin instead of argv (avoids shell history):
//   echo -n 'new-password' | docker compose exec -T -w /app summonarr \
//     node scripts/reset-password.mjs user@example.com --stdin

import { Client } from "pg";
import { scrypt as scryptCb, randomBytes } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb);

const SCRYPT_N = 1 << 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SCRYPT_SALT_BYTES = 16;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const PREFIX = "scrypt:1:";

async function hashPassword(password) {
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const key = await scrypt(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return `${PREFIX}${salt.toString("base64")}:${key.toString("base64")}`;
}

function usage(code = 0) {
  console.log(
    "Usage: node scripts/reset-password.mjs <email> <new-password> [--admin]\n" +
      "       node scripts/reset-password.mjs <email> --stdin [--admin]",
  );
  process.exit(code);
}

function parseArgs(argv) {
  const opts = { email: null, password: null, fromStdin: false, promote: false };
  const positional = [];
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") usage(0);
    else if (arg === "--stdin") opts.fromStdin = true;
    else if (arg === "--admin") opts.promote = true;
    else positional.push(arg);
  }
  if (positional.length === 0) usage(1);
  opts.email = positional[0];
  if (!opts.fromStdin) {
    if (positional.length < 2) usage(1);
    opts.password = positional[1];
  }
  return opts;
}

async function readStdin() {
  return await new Promise((resolve, reject) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      buf += chunk;
    });
    process.stdin.on("end", () => resolve(buf.replace(/\r?\n$/, "")));
    process.stdin.on("error", reject);
  });
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
      /^postgres(?:ql)?:\/\/([^:]+):(.+)@([^:/]+)(?::(\d+))?\/([^?]+)/,
    );
    if (!m) throw new Error("Cannot parse DATABASE_URL");
    const [, user, password, host, port, database] = m;
    return { user, password, host, port: port ? parseInt(port, 10) : 5432, database };
  }
  throw new Error("Set DATABASE_URL or PGHOST/PGUSER/PGPASSWORD/PGDATABASE");
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const password = opts.fromStdin ? await readStdin() : opts.password;
  if (!password || password.length < 8) {
    console.error("Password must be at least 8 characters.");
    process.exit(1);
  }

  const hash = await hashPassword(password);
  const client = new Client(connectionParams());
  await client.connect();
  try {
    const sql = opts.promote
      ? `UPDATE "User"
            SET "passwordHash" = $1,
                "passwordChangedAt" = NOW(),
                role = 'ADMIN'
          WHERE LOWER(email) = LOWER($2)
        RETURNING id, email, role`
      : `UPDATE "User"
            SET "passwordHash" = $1,
                "passwordChangedAt" = NOW()
          WHERE LOWER(email) = LOWER($2)
        RETURNING id, email, role`;
    const { rows } = await client.query(sql, [hash, opts.email]);
    if (rows.length === 0) {
      console.error(`No user found with email ${opts.email}.`);
      process.exit(2);
    }
    const u = rows[0];
    console.log(
      `Password reset for ${u.email} (${u.role}) [id: ${u.id}]. All existing sessions invalidated.`,
    );
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
