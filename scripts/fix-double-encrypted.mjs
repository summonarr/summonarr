#!/usr/bin/env node
// One-shot recovery: undo the double-encryption introduced by the regression
// in src/app/api/settings/route.ts where the route called encryptToken(value)
// on top of the Prisma extension's own encryption pass — producing rows of the
// form enc:v1:<iv1>:<tag1>:<ct1>  whose inner ciphertext, after one decrypt,
// is itself enc:v1:<iv2>:<tag2>:<ct2> (the actually-correct row).
//
// Detection: a row is double-encrypted when decrypting it once yields a
// string that still starts with "enc:v1:". Single-encrypted rows decrypt to
// the real plaintext (API keys, tokens) which never start with that prefix.
//
// Recovery: replace the on-disk value with the result of one decryption pass.
// That leaves a correctly single-encrypted row.
//
// Idempotent — running it twice is harmless. Safe on rows that are already
// single-encrypted or plaintext (those are skipped).
//
// Usage:
//   docker compose cp scripts/fix-double-encrypted.mjs summonarr:/app/scripts/
//   docker compose exec -w /app summonarr node scripts/fix-double-encrypted.mjs

import { Client } from "pg";
import { createDecipheriv } from "node:crypto";

const ENC_PREFIX = "enc:v1:";

// MUST match SETTINGS_SENSITIVE_KEYS in src/lib/settings-sensitive-keys.ts (and
// the copy in scripts/encrypt-existing-settings.mjs). This file can't import
// from TS, so the list is duplicated. It scopes the "legacy plaintext" count
// below: the Prisma extension encrypts ONLY these keys, so URLs, feature flags,
// intervals, setup_completed_at and every cron:lastRun:* row are plaintext BY
// DESIGN and must not be reported as rows encrypt-existing-settings.mjs could
// fix. Unused entries are harmless, so err toward listing too many.
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
  "radarr4kApiKey",
  "sonarr4kApiKey",
  "radarr4kWebhookSecret",
  "sonarr4kWebhookSecret",
  "omdbApiKey",
  "mdblistApiKey",
  "traktClientId",
  "ipinfoToken",
  "resendApiKey",
  "smtpPassword",
  "trashGithubToken",
  "apnsRelayKey",
];

// Per-instance Radarr/Sonarr and Plex/Jellyfin secret keys are admin-defined at
// runtime and can't be enumerated statically. Mirror ARR_INSTANCE_SECRET_RE and
// MEDIA_INSTANCE_SECRET_RE in settings-sensitive-keys.ts — the same shape gates
// the Prisma extension uses to decide what to encrypt.
const ARR_INSTANCE_SECRET_RE = /^(radarr|sonarr)([A-Z0-9][A-Za-z0-9]*)?(ApiKey|WebhookSecret)$/;
const MEDIA_INSTANCE_SECRET_RE = /^(plex([A-Z0-9][A-Za-z0-9]*)?AdminToken|jellyfin([A-Z0-9][A-Za-z0-9]*)?ApiKey)$/;

function getKey() {
  const hex = process.env.TOKEN_ENCRYPTION_KEY;
  if (!hex || !/^[0-9a-f]{64}$/i.test(hex)) {
    throw new Error("TOKEN_ENCRYPTION_KEY missing or malformed (must be 64 hex chars).");
  }
  return Buffer.from(hex, "hex");
}

// Mirrors src/lib/token-crypto.ts decryptToken (16-byte IV, 16-byte tag, AES-256-GCM).
// Returns null on any decode/auth failure so the caller can leave the row alone.
function tryDecrypt(value, key) {
  if (typeof value !== "string" || !value.startsWith(ENC_PREFIX)) return null;
  const parts = value.slice(ENC_PREFIX.length).split(":");
  if (parts.length !== 3) return null;
  let iv, tag, ct;
  try {
    iv  = Buffer.from(parts[0], "hex");
    tag = Buffer.from(parts[1], "hex");
    ct  = Buffer.from(parts[2], "hex");
  } catch {
    return null;
  }
  if (iv.length !== 16 || tag.length !== 16) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(ct).toString("utf8") + decipher.final("utf8");
  } catch {
    return null;
  }
}

// pg sends `user`/`password` verbatim, so a percent-encoded URL has to be
// decoded here or authentication fails. Percent-encoding is the form Prisma
// requires when the password holds "@", ":" or "/", AND the form
// docker-entrypoint.sh always builds (encodeURIComponent(POSTGRES_PASSWORD)),
// so the in-container DATABASE_URL is encoded too. A lone "%" that isn't a
// valid escape makes decodeURIComponent throw — keep that value as typed.
// Mirrors scripts/reset-password.mjs / scripts/create-user.mjs.
function decodeCredential(value) {
  if (value === undefined) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

async function main() {
  const key = getKey();

  let user, password, host, port, database;
  if (process.env.PGHOST && process.env.PGUSER && process.env.PGPASSWORD && process.env.PGDATABASE) {
    user = process.env.PGUSER;
    password = process.env.PGPASSWORD;
    host = process.env.PGHOST;
    port = process.env.PGPORT ? parseInt(process.env.PGPORT, 10) : 5432;
    database = process.env.PGDATABASE;
  } else if (process.env.DATABASE_URL) {
    // Parsed by hand rather than with pg's URL parser, which rejects the
    // unescaped reserved chars ("/", "=") a hand-written URL can carry. The
    // password is optional so a trust-auth URL (postgres://user@host/db) works.
    const m = process.env.DATABASE_URL.match(
      /^postgres(?:ql)?:\/\/([^:]+)(?::(.+))?@([^:/]+)(?::(\d+))?\/([^?]+)/,
    );
    if (!m) throw new Error("Cannot parse DATABASE_URL");
    [, user, password, host, port, database] = m;
    user = decodeCredential(user);
    password = decodeCredential(password);
    port = port ? parseInt(port, 10) : 5432;
  } else {
    throw new Error("Set DATABASE_URL or PGHOST/PGUSER/PGPASSWORD/PGDATABASE");
  }

  const client = new Client({ user, password, host, port, database });
  await client.connect();

  try {
    // ── Settings ─────────────────────────────────────────────────────────────
    let settingsFixed = 0;
    let settingsSingle = 0;
    let settingsPlaintext = 0;
    let settingsUndecodable = 0;

    const settings = await client.query(
      'SELECT key, value FROM "Setting" WHERE value LIKE $1',
      [ENC_PREFIX + "%"]
    );
    for (const row of settings.rows) {
      const decrypted = tryDecrypt(row.value, key);
      if (decrypted === null) {
        settingsUndecodable++;
        console.warn(`[settings] could not decrypt: ${row.key} (skipped)`);
        continue;
      }
      if (decrypted.startsWith(ENC_PREFIX)) {
        await client.query('UPDATE "Setting" SET value = $1 WHERE key = $2', [decrypted, row.key]);
        settingsFixed++;
        console.log(`[settings] fixed double-encrypted: ${row.key}`);
      } else {
        settingsSingle++;
      }
    }

    // Only keys the Prisma extension would encrypt count as "legacy plaintext";
    // every other Setting row is plaintext by design (see SENSITIVE_KEYS above).
    const plaintext = await client.query(
      'SELECT COUNT(*)::int AS n FROM "Setting" WHERE (key = ANY($2::text[]) OR key ~ $3 OR key ~ $4) AND value IS NOT NULL AND value <> \'\' AND value NOT LIKE $1',
      [ENC_PREFIX + "%", SENSITIVE_KEYS, ARR_INSTANCE_SECRET_RE.source, MEDIA_INSTANCE_SECRET_RE.source]
    );
    settingsPlaintext = plaintext.rows[0].n;

    // ── Account OAuth tokens ─────────────────────────────────────────────────
    let accountsFixed = 0;
    let accountsClean = 0;

    const acc = await client.query(
      'SELECT id, refresh_token, access_token, id_token FROM "Account"'
    );
    for (const a of acc.rows) {
      const updates = [];
      const params = [];
      let i = 1;
      let touched = false;
      for (const col of ["refresh_token", "access_token", "id_token"]) {
        const v = a[col];
        if (typeof v !== "string" || !v.startsWith(ENC_PREFIX)) continue;
        const decrypted = tryDecrypt(v, key);
        if (decrypted === null) continue;
        if (decrypted.startsWith(ENC_PREFIX)) {
          updates.push(`"${col}" = $${i++}`);
          params.push(decrypted);
          touched = true;
        }
      }
      if (!touched) {
        accountsClean++;
        continue;
      }
      params.push(a.id);
      await client.query(
        `UPDATE "Account" SET ${updates.join(", ")} WHERE id = $${i}`,
        params
      );
      accountsFixed++;
      console.log(`[account] fixed double-encrypted: id=${a.id}`);
    }

    console.log("");
    console.log("Settings:");
    console.log(`  fixed (double→single)   ${settingsFixed}`);
    console.log(`  already single          ${settingsSingle}`);
    console.log(`  legacy plaintext        ${settingsPlaintext}  (run encrypt-existing-settings.mjs for these)`);
    if (settingsUndecodable > 0) {
      console.log(`  undecodable             ${settingsUndecodable}  (wrong key or corrupt row)`);
    }
    console.log("Accounts:");
    console.log(`  fixed (double→single)   ${accountsFixed}`);
    console.log(`  already clean           ${accountsClean}`);

    if (settingsFixed === 0 && accountsFixed === 0) {
      console.log("\nNothing to do — no double-encrypted rows found.");
    } else {
      console.log("\nDone. Double-encrypted rows have been collapsed to single encryption.");
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
