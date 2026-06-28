#!/usr/bin/env node
// One-shot migration: encrypt sensitive Setting, Account, and PushSubscription
// rows that were stored plaintext before encryption-at-rest landed.
//
// The Prisma extension at src/lib/prisma.ts encrypts on every Setting and
// Account write going forward, and PushSubscription writes are encrypted at the
// call site — but pre-existing rows on disk stay plaintext until something
// updates them. This script reads each affected row and rewrites it using the
// same AES-256-GCM scheme as src/lib/token-crypto.ts.
//
// Standalone — uses only `pg` (already in the app bundle) and Node's
// built-in `crypto`. No Prisma dependency, so it runs inside the
// standalone Next.js Docker image without runtime tracing concerns.
//
// Usage:
//   docker compose cp scripts/encrypt-existing-settings.mjs summonarr:/app/scripts/
//   docker compose exec -w /app summonarr node scripts/encrypt-existing-settings.mjs
//
// Idempotent — running it twice is harmless.

import { Client } from "pg";
import { createCipheriv, randomBytes } from "node:crypto";

// MUST match SETTINGS_SENSITIVE_KEYS in src/lib/settings-sensitive-keys.ts
// (the canonical source-of-truth that prisma.ts and settings/route.ts both
// import). This file can't import from TS, so the list is duplicated — but
// the boot-time assertion in src/app/api/settings/route.ts catches schema
// drift, and unused entries here are harmless (the LIKE query just returns
// no rows for them).
const SENSITIVE_KEYS = [
  "plexAdminToken",
  "jellyfinApiKey",
  "vapidPrivateKey",
  "webhookSecret",
  "sonarrWebhookSecret",
  "radarrWebhookSecret",
  "discordBotToken",
  "radarrApiKey",
  "sonarrApiKey",
  "omdbApiKey",
  "mdblistApiKey",
  "traktClientId",
  "ipinfoToken",
  "resendApiKey",
  "smtpPassword",
  "trashGithubToken",
];

const ENC_PREFIX = "enc:v1:";

function getKey() {
  const hex = process.env.TOKEN_ENCRYPTION_KEY;
  if (!hex || !/^[0-9a-f]{64}$/i.test(hex)) {
    throw new Error("TOKEN_ENCRYPTION_KEY missing or malformed (must be 64 hex chars).");
  }
  return Buffer.from(hex, "hex");
}

function encrypt(plaintext, key) {
  // 16-byte IV matches src/lib/token-crypto.ts. Non-canonical for GCM (12 is
  // standard) but functional, and existing encrypted rows on disk use 16.
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ENC_PREFIX + iv.toString("hex") + ":" + tag.toString("hex") + ":" + ct.toString("hex");
}

async function main() {
  const key = getKey();

  // Prefer explicit PG* env vars when set (lets the operator override the
  // host without re-encoding the password). Fall back to parsing DATABASE_URL.
  let user, password, host, port, database;
  if (process.env.PGHOST && process.env.PGUSER && process.env.PGPASSWORD && process.env.PGDATABASE) {
    user = process.env.PGUSER;
    password = process.env.PGPASSWORD;
    host = process.env.PGHOST;
    port = process.env.PGPORT ? parseInt(process.env.PGPORT, 10) : 5432;
    database = process.env.PGDATABASE;
  } else if (process.env.DATABASE_URL) {
    // Parse manually — pg's URL parser rejects passwords containing unescaped
    // reserved chars like "/" or "=", which the entrypoint's URL doesn't escape.
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
    // ── Settings ─────────────────────────────────────────────────────────────
    let settingsRewrote = 0;
    let settingsAlreadyEncrypted = 0;
    let settingsEmpty = 0;

    for (const skey of SENSITIVE_KEYS) {
      const r = await client.query('SELECT value FROM "Setting" WHERE key = $1', [skey]);
      if (r.rowCount === 0) continue;
      const value = r.rows[0].value;
      if (!value) {
        settingsEmpty++;
        continue;
      }
      if (value.startsWith(ENC_PREFIX)) {
        settingsAlreadyEncrypted++;
        continue;
      }
      const ciphertext = encrypt(value, key);
      await client.query('UPDATE "Setting" SET value = $1 WHERE key = $2', [ciphertext, skey]);
      settingsRewrote++;
      console.log(`[settings] re-encrypted: ${skey}`);
    }

    // ── Account OAuth tokens ─────────────────────────────────────────────────
    let accountsRewrote = 0;
    let accountsClean = 0;
    const acc = await client.query(
      'SELECT id, refresh_token, access_token, id_token FROM "Account"'
    );
    for (const a of acc.rows) {
      const updates = [];
      const params = [];
      let i = 1;
      let needsRewrite = false;
      for (const col of ["refresh_token", "access_token", "id_token"]) {
        const v = a[col];
        if (v && !v.startsWith(ENC_PREFIX)) {
          updates.push(`"${col}" = $${i++}`);
          params.push(encrypt(v, key));
          needsRewrite = true;
        }
      }
      if (!needsRewrite) {
        accountsClean++;
        continue;
      }
      params.push(a.id);
      await client.query(
        `UPDATE "Account" SET ${updates.join(", ")} WHERE id = $${i}`,
        params
      );
      accountsRewrote++;
      console.log(`[account] re-encrypted: id=${a.id}`);
    }

    // ── Push subscription crypto material ────────────────────────────────────
    // PushSubscription columns are encrypted at the call site (the Prisma
    // extension does not cover that table), so rows written before that rollout
    // hold plaintext web-push keys / APNs device tokens. Re-encrypt them with the
    // same scheme; the ENC_PREFIX check keeps it idempotent.
    let pushRewrote = 0;
    let pushClean = 0;
    const push = await client.query(
      'SELECT id, p256dh, auth, "deviceToken" FROM "PushSubscription"'
    );
    for (const s of push.rows) {
      const updates = [];
      const params = [];
      let i = 1;
      let needsRewrite = false;
      for (const col of ["p256dh", "auth", "deviceToken"]) {
        const v = s[col];
        if (v && !v.startsWith(ENC_PREFIX)) {
          updates.push(`"${col}" = $${i++}`);
          params.push(encrypt(v, key));
          needsRewrite = true;
        }
      }
      if (!needsRewrite) {
        pushClean++;
        continue;
      }
      params.push(s.id);
      await client.query(
        `UPDATE "PushSubscription" SET ${updates.join(", ")} WHERE id = $${i}`,
        params
      );
      pushRewrote++;
      console.log(`[push] re-encrypted: id=${s.id}`);
    }

    console.log("");
    console.log("Settings:");
    console.log(`  re-encrypted        ${settingsRewrote}`);
    console.log(`  already encrypted   ${settingsAlreadyEncrypted}`);
    console.log(`  empty / missing     ${settingsEmpty}`);
    console.log("Accounts:");
    console.log(`  re-encrypted        ${accountsRewrote}`);
    console.log(`  already clean       ${accountsClean}`);
    console.log("Push subscriptions:");
    console.log(`  re-encrypted        ${pushRewrote}`);
    console.log(`  already clean       ${pushClean}`);

    if (settingsRewrote === 0 && accountsRewrote === 0 && pushRewrote === 0) {
      console.log("\nNothing to do — every sensitive row is already encrypted at rest.");
    } else {
      console.log("\nDone. All sensitive rows are now encrypted at rest.");
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
