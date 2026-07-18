#!/usr/bin/env node
// Create a local-credentials user from the host or container.
//
// Summonarr closes public self-registration after the first user (the /setup
// admin), and there is no admin "create user" action — after setup, new accounts
// only arrive via OAuth (Plex/Jellyfin/OIDC). This script fills that gap: it
// inserts a username/password user directly, e.g. a demo account for Apple App
// Review (reviewers can't complete your Plex/Jellyfin OAuth, so they need local
// credentials) on a publicly reachable dev/demo instance.
//
// It seeds `permissions` from the role preset (a raw insert would otherwise leave
// permissions = 0 = a user who can't even request) and marks setup as complete so
// the instance doesn't show the first-run wizard or auto-promote the next OAuth
// user to ADMIN.
//
// Standalone — uses only `pg` and node:crypto. Mirrors the scrypt parameters in
// src/lib/password-hash.ts, the role presets in src/lib/permissions.ts, and the
// email normalization in src/lib/email-normalize.ts; keep them in sync.
//
// Usage (the script ships inside the image at /app/scripts/create-user.mjs):
//   docker compose exec -w /app summonarr \
//     node scripts/create-user.mjs review@example.com 'demo-password' --name 'App Review'
//
//   # Make it an admin (default role is USER):
//   docker compose exec -w /app summonarr \
//     node scripts/create-user.mjs admin@example.com 'demo-password' --admin
//
//   # Read the password from stdin instead of argv (avoids shell history):
//   echo -n 'demo-password' | docker compose exec -T -w /app summonarr \
//     node scripts/create-user.mjs review@example.com --stdin
//
//   # Or against the host DB directly:
//   DATABASE_URL=postgres://... node scripts/create-user.mjs review@example.com 'demo-password'
//
// To change an existing user's password instead, use scripts/reset-password.mjs.

import { Client } from "pg";
import { scrypt as scryptCb, randomBytes, randomUUID } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb);

// Mirrors hashPassword() in src/lib/password-hash.ts.
const SCRYPT_N = 1 << 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SCRYPT_SALT_BYTES = 16;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const PREFIX = "scrypt:1:";

// Mirrors PRESETS in src/lib/permissions.ts (kept as plain decimals, like
// scripts/migrate-role-permissions.mjs): USER = REQUEST|REQUEST_MOVIE|REQUEST_TV
// (16|32|64 = 112); ISSUE_ADMIN = 112|MANAGE_ISSUES (|8 = 120); ADMIN = the
// superbit (1). The column is BIGINT so the value is passed as a string + ::bigint.
const PRESETS = { USER: "112", ISSUE_ADMIN: "120", ADMIN: "1" };
const ROLES = Object.keys(PRESETS);

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

// Mirrors src/lib/email-normalize.ts so the stored email matches sign-in lookup.
function normalizeEmail(email) {
  return email.normalize("NFKC").toLowerCase().trim();
}

function usage(code = 0) {
  console.log(
    "Usage: node scripts/create-user.mjs <email> <password> [--name \"Full Name\"] [--role USER|ISSUE_ADMIN|ADMIN] [--admin]\n" +
      "       node scripts/create-user.mjs <email> --stdin [--role ...] [--name ...]\n" +
      "\n" +
      "  --admin   shorthand for --role ADMIN (default role is USER)\n" +
      "  --stdin   read the password from stdin instead of argv\n" +
      "\n" +
      "To change an existing user's password, use scripts/reset-password.mjs.",
  );
  process.exit(code);
}

function parseArgs(argv) {
  const opts = { email: null, password: null, name: null, role: "USER", fromStdin: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") usage(0);
    else if (arg === "--stdin") opts.fromStdin = true;
    else if (arg === "--admin") opts.role = "ADMIN";
    else if (arg === "--name") opts.name = argv[++i] ?? null;
    else if (arg === "--role") opts.role = (argv[++i] ?? "").toUpperCase();
    else positional.push(arg);
  }
  if (positional.length === 0) usage(1);
  opts.email = positional[0];
  if (!opts.fromStdin) {
    if (positional.length < 2) usage(1);
    opts.password = positional[1];
  }
  if (!ROLES.includes(opts.role)) {
    console.error(`Invalid role "${opts.role}". Expected one of: ${ROLES.join(", ")}.`);
    process.exit(1);
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

  const email = normalizeEmail(opts.email);
  const at = email.split("@");
  if (at.length !== 2 || !at[0] || !at[1] || !at[1].includes(".")) {
    console.error(`Invalid email address: ${opts.email}`);
    process.exit(1);
  }

  const password = opts.fromStdin ? await readStdin() : opts.password;
  if (!password || password.length < 8) {
    console.error("Password must be at least 8 characters.");
    process.exit(1);
  }

  const name = opts.name && opts.name.trim() ? opts.name.trim().slice(0, 100) : null;
  const hash = await hashPassword(password);

  const client = new Client(connectionParams());
  await client.connect();
  try {
    let row;
    try {
      const { rows } = await client.query(
        `INSERT INTO "User" (id, email, name, "passwordHash", role, permissions, "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, $5::"Role", $6::bigint, now(), now())
         RETURNING id, email, role, permissions`,
        [randomUUID(), email, name, hash, opts.role, PRESETS[opts.role]],
      );
      row = rows[0];
    } catch (err) {
      if (err && err.code === "23505") {
        console.error(
          `A user with email ${email} already exists. Use scripts/reset-password.mjs to change its password.`,
        );
        process.exit(2);
      }
      throw err;
    }

    // Mark setup complete so a fresh instance doesn't show the first-run wizard
    // or auto-promote the next OAuth user to ADMIN. No-op if already set.
    await client.query(
      `INSERT INTO "Setting" (key, value, "updatedAt")
       VALUES ('setup_completed_at', $1, now())
       ON CONFLICT (key) DO NOTHING`,
      [new Date().toISOString()],
    );

    console.log(
      `Created ${row.role} user ${row.email} [id: ${row.id}, permissions: ${row.permissions}]. Sign in with this email + password.`,
    );
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
