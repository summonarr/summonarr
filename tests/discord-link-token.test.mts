// The /link code is stored hashed (src/lib/discord-link-token.ts). The route
// behaviour is pinned where it runs — tests/discord-routes.test.mts (generate-link
// stores only the hash) and tests/interactions-route.test.mts (/link looks up by
// the hash; a legacy plaintext row and the stored hash itself are refused). This
// file pins the helpers and the one structural rule a new call site could break:
// the DiscordLinkToken.token column is only ever written or matched with a hash.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  generateDiscordLinkToken,
  hashDiscordLinkToken,
  isWellFormedDiscordLinkToken,
  normalizeDiscordLinkToken,
} from "../src/lib/discord-link-token.ts";

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

test("a generated code is 128 bits of uppercase hex, and its hash is the SHA-256 of it", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 50; i++) {
    const { token, tokenHash } = generateDiscordLinkToken();
    assert.match(token, /^[0-9A-F]{32}$/);
    assert.equal(tokenHash, sha256(token));
    assert.notEqual(tokenHash, token);
    assert.ok(isWellFormedDiscordLinkToken(token), "a generated code passes the shape check");
    seen.add(token);
  }
  assert.equal(seen.size, 50, "codes are random");
});

test("the hash is 64 lowercase hex characters, so it can never pass as a code", () => {
  const { tokenHash } = generateDiscordLinkToken();
  assert.match(hashDiscordLinkToken("A".repeat(32)), /^[0-9a-f]{64}$/);
  assert.equal(isWellFormedDiscordLinkToken(tokenHash), false);
  assert.equal(isWellFormedDiscordLinkToken(tokenHash.toUpperCase()), false);
});

test("normalization removes stray spaces and case before the shape check and the hash", () => {
  const { token } = generateDiscordLinkToken();
  assert.equal(normalizeDiscordLinkToken(`  ${token.toLowerCase()}\t`), token);
  assert.equal(hashDiscordLinkToken(normalizeDiscordLinkToken(token.toLowerCase())), sha256(token));
  for (const bad of ["", "ABC", "G".repeat(32), `${token}0`, ` ${token}`, token.toLowerCase()]) {
    assert.equal(isWellFormedDiscordLinkToken(bad), false, JSON.stringify(bad));
  }
});

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (full.includes(join("src", "generated"))) continue;
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

test("PIN: every DiscordLinkToken query that names the token column passes a hash", () => {
  // A new writer storing the plaintext code, or a reader matching on it, would
  // put the credential back into the DB and every backup. userId-keyed deletes
  // (footholds, purge, the expiry sweep) never name the column and are fine.
  const call = /discordLinkToken\.(\w+)\(\{([\s\S]*?)\}\);/g;
  const sites: string[] = [];
  for (const file of sourceFiles("src")) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(call)) {
      // `token` as a key or a shorthand property; `tokenHash` alone is not one.
      const tokenArgs = [...m[2].matchAll(/\btoken\b\s*(?::\s*([\w.]+))?/g)];
      for (const arg of tokenArgs) {
        sites.push(`${file}: ${m[1]}`);
        assert.equal(
          arg[1],
          "tokenHash",
          `${file}: discordLinkToken.${m[1]} sets the token column to ${arg[1] ?? "a shorthand `token`"} — store and match only hashDiscordLinkToken(...)`,
        );
      }
    }
  }
  // Non-vacuous: the generate-link upsert (update + create) and /link's
  // lookup, expiry delete and consume all name the column today.
  assert.ok(sites.length >= 5, `expected at least 5 token-column sites, found ${sites.length}: ${sites.join(", ")}`);
});
