#!/usr/bin/env node
// Create a local-credentials user from the host or container.
//
// Summonarr closes public self-registration after the first user (the /setup
// admin). After that, a username/password account can only be made by a
// signed-in admin (Admin → Users → "Create user"). This script does the same
// thing from the shell, with no sign-in needed — handy for a fresh instance or
// a demo account for Apple App Review (reviewers can't complete your
// Plex/Jellyfin OAuth, so they need local credentials).
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

async function hashPassword(password) {
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

// Mirrors PRESETS in src/lib/permissions.ts (kept as plain decimals, like
// scripts/migrate-role-permissions.mjs): USER = REQUEST|REQUEST_MOVIE|REQUEST_TV
// (16|32|64 = 112); ISSUE_ADMIN = 112|MANAGE_ISSUES (|8 = 120); ADMIN = the
// superbit (1). The column is BIGINT so the value is passed as a string + ::bigint.
const PRESETS = { USER: "112", ISSUE_ADMIN: "120", ADMIN: "1" };
const ROLES = Object.keys(PRESETS);

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

// pg sends `user`/`password` verbatim, so a percent-encoded URL (the form
// Prisma requires when the password holds "@", ":" or "/") has to be decoded
// here or authentication fails. A lone "%" that isn't a valid escape makes
// decodeURIComponent throw — keep that value as typed.
function decodeCredential(value) {
  if (value === undefined) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
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
  // Bundled Postgres (the docker-container/ compose): docker-entrypoint.sh builds
  // DATABASE_URL from POSTGRES_PASSWORD at startup and ignores any DATABASE_URL in
  // .env — but `docker compose exec` runs a fresh process that never sees that
  // export, so read the database exactly the way the entrypoint does.
  if (process.env.POSTGRES_PASSWORD) {
    return { user: "summonarr", password: process.env.POSTGRES_PASSWORD, host: "postgres", port: 5432, database: "summonarr" };
  }
  if (process.env.DATABASE_URL) {
    // Parsed by hand rather than with pg's URL parser, which rejects the
    // unescaped reserved chars ("/", "=") a hand-written URL can carry. The
    // password is optional so a trust-auth URL (postgres://user@host/db) works.
    const m = process.env.DATABASE_URL.match(
      /^postgres(?:ql)?:\/\/([^:]+)(?::(.+))?@([^:/]+)(?::(\d+))?\/([^?]+)/,
    );
    if (!m) throw new Error("Cannot parse DATABASE_URL");
    const [, user, password, host, port, database] = m;
    return {
      user: decodeCredential(user),
      password: decodeCredential(password),
      host,
      port: port ? parseInt(port, 10) : 5432,
      database,
    };
  }
  throw new Error("Set POSTGRES_PASSWORD (bundled Postgres), DATABASE_URL, or PGHOST/PGUSER/PGPASSWORD/PGDATABASE");
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
  // The app's floor (registration, password change, admin create).
  if (!password || password.length < 12) {
    console.error("Password must be at least 12 characters.");
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
