// Review 2026-09, package P13 — the one-shot operator scripts under scripts/.
//
// The scripts are top-level programs (they connect to Postgres on import), so
// nothing here imports them. Instead each pin reads the script SOURCE, lifts
// the exact DATABASE_URL regex and the `decodeCredential` helper out of it, and
// exercises those in isolation. That is enough to catch the two ways the
// defects come back: a script dropping the decode (a percent-encoded password
// reaches pg verbatim and auth fails) or reverting to the required-password
// regex (a trust-auth URL is rejected as unparseable).
//
//   f7 / f11 — seven scripts parsed DATABASE_URL and handed the still
//              percent-encoded user/password straight to `new Client(...)`.
//              Prisma REQUIRES percent-encoding when the password holds "@",
//              ":" or "/", and docker-entrypoint.sh always builds the URL with
//              encodeURIComponent(POSTGRES_PASSWORD), so this failed on every
//              non-trivial password. create-user/reset-password had already
//              been fixed (64f5b2b); the siblings had not.
//   f8       — fix-double-encrypted.mjs counted EVERY non-enc:v1: Setting row
//              as "legacy plaintext", so a fully-migrated deployment was still
//              told to run encrypt-existing-settings.mjs (which then found
//              nothing). The count is now scoped to the keys the Prisma
//              extension actually encrypts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  SETTINGS_SENSITIVE_KEYS,
  isSensitiveSettingKey,
} from "@/lib/settings-sensitive-keys.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const SCRIPTS = [
  "scripts/encrypt-existing-settings.mjs",
  "scripts/fix-double-encrypted.mjs",
  "scripts/migrate-legacy-passwords.mjs",
  "scripts/migrate-role-permissions.mjs",
  "scripts/migrate-is4k-to-arrinstance.mjs",
  "scripts/migrate-media-server-instance.mjs",
  "scripts/migrate-webhook-secrets.mjs",
  // The two scripts the fix was copied FROM — pinned too so the nine parsers
  // can't drift apart again.
  "scripts/create-user.mjs",
  "scripts/reset-password.mjs",
];

function source(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

function extractUrlRegex(rel: string, src: string): RegExp {
  const m = src.match(/DATABASE_URL\.match\(\s*\/(.+)\/,?\s*\);/);
  assert.ok(m, `${rel}: DATABASE_URL regex not found`);
  return new RegExp(m[1]);
}

function extractDecodeCredential(rel: string, src: string): (v: string | undefined) => string | undefined {
  const m = src.match(/function decodeCredential\(value\) \{[\s\S]*?\n\}/);
  assert.ok(m, `${rel}: decodeCredential helper not found`);
  // The helper is self-contained (decodeURIComponent + try/catch), so lifting
  // it into a Function is exactly the code the script runs.
  return new Function(`${m[0]}; return decodeCredential;`)();
}

test("f7/f11: every operator script decodes percent-encoded DATABASE_URL credentials before handing them to pg", () => {
  for (const rel of SCRIPTS) {
    const src = source(rel);
    const re = extractUrlRegex(rel, src);
    const decode = extractDecodeCredential(rel, src);

    // The form Prisma requires (and the entrypoint emits) for a password
    // holding "@" and "/".
    const m = "postgresql://summ%40narr:p%40ss%2Fword@db:5433/summonarr?schema=public".match(re);
    assert.ok(m, `${rel}: percent-encoded URL must parse`);
    assert.equal(decode(m[1]), "summ@narr", `${rel}: user must be decoded`);
    assert.equal(decode(m[2]), "p@ss/word", `${rel}: password must be decoded`);
    assert.equal(m[3], "db");
    assert.equal(m[4], "5433");
    assert.equal(m[5], "summonarr");

    // A lone "%" that is not a valid escape is kept as typed, not thrown on.
    assert.equal(decode("p%zzword"), "p%zzword", `${rel}: invalid escape passes through`);
    assert.equal(decode(undefined), undefined, `${rel}: undefined passes through`);

    // The parsed groups must actually be ROUTED through the helper — a helper
    // that exists but is never applied is the same bug.
    assert.match(
      src,
      /user = decodeCredential\((?:user|rawUser|m\[1\])\)|user: decodeCredential\((?:user|rawUser|m\[1\])\)/,
      `${rel}: user is not passed through decodeCredential`,
    );
    assert.match(
      src,
      /password = decodeCredential\((?:password|rawPassword|m\[2\])\)|password: decodeCredential\((?:password|rawPassword|m\[2\])\)/,
      `${rel}: password is not passed through decodeCredential`,
    );
  }
});

test("f11: a password-less trust-auth DATABASE_URL parses in every operator script", () => {
  for (const rel of SCRIPTS) {
    const src = source(rel);
    const re = extractUrlRegex(rel, src);
    const decode = extractDecodeCredential(rel, src);
    const m = "postgres://summonarr@localhost/summonarr".match(re);
    assert.ok(m, `${rel}: trust-auth URL (no password) must parse`);
    assert.equal(decode(m[1]), "summonarr");
    assert.equal(m[2], undefined, `${rel}: absent password must be undefined, not ""`);
    assert.equal(decode(m[2]), undefined);
    assert.equal(m[3], "localhost");
    assert.equal(m[5], "summonarr");
  }
});

test("f7: the stale 'entrypoint does not escape' comment is gone — the entrypoint DOES percent-encode", () => {
  const src = source("scripts/encrypt-existing-settings.mjs");
  assert.doesNotMatch(src, /entrypoint's URL doesn't escape/);
  const entrypoint = source("docker-entrypoint.sh");
  assert.match(entrypoint, /encodeURIComponent\(process\.env\.POSTGRES_PASSWORD\)/);
});

// ── f8 ─────────────────────────────────────────────────────────────────────

function extractKeyList(rel: string, src: string): string[] {
  const m = src.match(/const SENSITIVE_KEYS = \[([\s\S]*?)\];/);
  assert.ok(m, `${rel}: SENSITIVE_KEYS not found`);
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

function extractRegexConst(rel: string, src: string, name: string): RegExp {
  const m = src.match(new RegExp(`const ${name} = /(.+)/;`));
  assert.ok(m, `${rel}: ${name} not found`);
  return new RegExp(m[1]);
}

const PREDICATE_SAMPLES = [
  // sensitive
  "plexAdminToken",
  "jellyfinApiKey",
  "radarrApiKey",
  "sonarr4kWebhookSecret",
  "radarrAnimeApiKey",
  "sonarrAnimeWebhookSecret",
  "plexRemoteAdminToken",
  "jellyfinRemoteApiKey",
  "apnsRelayKey",
  // plaintext by design
  "radarrUrl",
  "radarrAnimeUrl",
  "radarrAnimeRootFolder",
  "jellyfinUrl",
  "plexServerUrl",
  "plexRemoteServerUrl",
  "jellyfinRemoteServerUrl",
  "plexRemoteLibraries",
  "setup_completed_at",
  "cron:lastRun:sync:full",
  "feature.integration.push",
];

for (const rel of ["scripts/fix-double-encrypted.mjs", "scripts/encrypt-existing-settings.mjs"]) {
  test(`f8: ${rel} sensitivity predicate matches isSensitiveSettingKey exactly`, () => {
    const src = source(rel);
    assert.deepEqual(extractKeyList(rel, src), [...SETTINGS_SENSITIVE_KEYS]);
    const arr = extractRegexConst(rel, src, "ARR_INSTANCE_SECRET_RE");
    const media = extractRegexConst(rel, src, "MEDIA_INSTANCE_SECRET_RE");
    const keys = new Set(extractKeyList(rel, src));
    for (const key of PREDICATE_SAMPLES) {
      const scriptSays = keys.has(key) || arr.test(key) || media.test(key);
      assert.equal(scriptSays, isSensitiveSettingKey(key), `${rel}: disagrees with isSensitiveSettingKey on ${key}`);
    }
  });
}

test("f8: fix-double-encrypted's 'legacy plaintext' count is scoped to encryptable keys", () => {
  const src = source("scripts/fix-double-encrypted.mjs");
  // The literal holds an escaped '' (value <> \'\'), so match through to NOT LIKE $1.
  const m = src.match(/'SELECT COUNT\(\*\)::int AS n FROM "Setting" WHERE (.+?value NOT LIKE \$1)'/);
  assert.ok(m, "plaintext count query not found");
  const where = m[1];
  assert.match(where, /key = ANY\(\$2::text\[\]\)/, "static key list must gate the count");
  assert.match(where, /key ~ \$3/, "arr instance regex must gate the count");
  assert.match(where, /key ~ \$4/, "media instance regex must gate the count");
  assert.match(where, /value NOT LIKE \$1/);
  // And the params line actually supplies those four in that order.
  assert.match(
    src,
    /\[ENC_PREFIX \+ "%", SENSITIVE_KEYS, ARR_INSTANCE_SECRET_RE\.source, MEDIA_INSTANCE_SECRET_RE\.source\]/,
  );
});

test("f8: encrypt-existing-settings also targets per-instance media-server secrets", () => {
  const src = source("scripts/encrypt-existing-settings.mjs");
  assert.match(
    src,
    /ARR_INSTANCE_SECRET_RE\.test\(k\) \|\| MEDIA_INSTANCE_SECRET_RE\.test\(k\)/,
    "targetKeys must union both shape gates",
  );
});
