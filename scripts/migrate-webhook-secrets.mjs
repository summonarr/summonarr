#!/usr/bin/env node
// One-shot migration: copy the legacy webhookSecret value into the four
// new per-source webhook secret rows (plex/jellyfin/sonarr/radarr) when those
// rows are not already set. Lets the legacy fallback path in each webhook
// handler stay backward-compatible until operators flip to per-source secrets.
//
// Standalone — uses only `pg` and Node's built-in `crypto`. No Prisma. Matches
// the pattern in scripts/encrypt-existing-settings.mjs.
//
// Usage:
//   docker compose cp scripts/migrate-webhook-secrets.mjs summonarr:/app/scripts/
//   docker compose exec -w /app summonarr node scripts/migrate-webhook-secrets.mjs
//
// Idempotent — running it twice is harmless.

import { Client } from "pg";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const TARGET_KEYS = [
  "plexWebhookSecret",
  "jellyfinWebhookSecret",
  "sonarrWebhookSecret",
  "radarrWebhookSecret",
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
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ENC_PREFIX + iv.toString("hex") + ":" + tag.toString("hex") + ":" + ct.toString("hex");
}

function decrypt(value, key) {
  if (!value.startsWith(ENC_PREFIX)) return value;
  const parts = value.slice(ENC_PREFIX.length).split(":");
  if (parts.length !== 3) throw new Error("Malformed ciphertext");
  const [ivHex, tagHex, ctHex] = parts;
  const iv = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  const ct = Buffer.from(ctHex, "hex");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString("utf8");
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
    const legacy = await client.query('SELECT value FROM "Setting" WHERE key = $1', ["webhookSecret"]);
    if (legacy.rowCount === 0 || !legacy.rows[0].value) {
      console.log("No legacy webhookSecret row found — nothing to copy.");
      return;
    }
    const legacyValueRaw = legacy.rows[0].value;
    const plaintext = decrypt(legacyValueRaw, key);
    if (!plaintext) {
      console.log("Legacy webhookSecret decrypted to empty string — nothing to copy.");
      return;
    }

    let created = 0;
    let alreadySet = 0;

    for (const tkey of TARGET_KEYS) {
      const existing = await client.query('SELECT value FROM "Setting" WHERE key = $1', [tkey]);
      if (existing.rowCount > 0 && existing.rows[0].value) {
        alreadySet++;
        continue;
      }
      const ciphertext = encrypt(plaintext, key);
      if (existing.rowCount === 0) {
        await client.query(
          'INSERT INTO "Setting" (key, value) VALUES ($1, $2)',
          [tkey, ciphertext]
        );
      } else {
        await client.query(
          'UPDATE "Setting" SET value = $1 WHERE key = $2',
          [ciphertext, tkey]
        );
      }
      created++;
      console.log(`[settings] seeded: ${tkey}`);
    }

    console.log("");
    console.log(`Seeded:        ${created}`);
    console.log(`Already set:   ${alreadySet}`);
    if (created === 0) {
      console.log("\nNothing to do — every per-source webhook secret already has a value.");
    } else {
      console.log("\nDone. Per-source webhook secrets are now populated from the legacy secret.");
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
