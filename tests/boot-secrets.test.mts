// Guardrail 6g: the three server secrets must be independent values. Reusing
// NEXTAUTH_SECRET as CRON_SECRET lets whoever holds the cron bearer (sent over
// the wire by schedulers) forge an ADMIN session; either one equal to
// TOKEN_ENCRYPTION_KEY lets its holder decrypt every stored credential.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { secretReuseError } from "../src/lib/boot-secrets.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);
const TEK = "ab".repeat(32);

test("distinct secrets pass; missing ones are left to the presence/length checks", () => {
  assert.equal(secretReuseError({ nextAuthSecret: A, cronSecret: B, tokenEncryptionKey: TEK }), null);
  assert.equal(secretReuseError({}), null);
  assert.equal(secretReuseError({ nextAuthSecret: "", cronSecret: "" }), null, "two blanks are not a reuse");
});

test("NEXTAUTH_SECRET reused as CRON_SECRET is refused (whitespace-padded too)", () => {
  assert.match(secretReuseError({ nextAuthSecret: A, cronSecret: ` ${A}\n`, tokenEncryptionKey: TEK }) ?? "", /NEXTAUTH_SECRET and CRON_SECRET/);
});

test("either secret equal to TOKEN_ENCRYPTION_KEY is refused, case-insensitively", () => {
  assert.match(secretReuseError({ nextAuthSecret: TEK.toUpperCase(), cronSecret: B, tokenEncryptionKey: TEK }) ?? "", /NEXTAUTH_SECRET and TOKEN_ENCRYPTION_KEY/);
  assert.match(secretReuseError({ nextAuthSecret: A, cronSecret: TEK, tokenEncryptionKey: TEK.toUpperCase() }) ?? "", /CRON_SECRET and TOKEN_ENCRYPTION_KEY/);
});

test("boot wires the check and exits on it in production", () => {
  const src = readFileSync(new URL("../src/instrumentation.ts", import.meta.url), "utf8");
  const call = src.indexOf("secretReuseError({");
  assert.ok(call > 0, "instrumentation.ts must call secretReuseError");
  const after = src.slice(call, call + 600);
  assert.match(after, /nextAuthSecret: process\.env\.NEXTAUTH_SECRET/);
  assert.match(after, /cronSecret: process\.env\.CRON_SECRET/);
  assert.match(after, /tokenEncryptionKey: process\.env\.TOKEN_ENCRYPTION_KEY/);
  assert.match(after, /if \(reuse\) refuse\(reuse, "production"\);/);
  assert.match(src, /if \(bootRefused\(checkBootEnv\(\), process\.env\.NODE_ENV\)\) process\.exit\(1\);/, "a recorded refusal exits");
});

test("a missing NEXTAUTH_SECRET is reported once, by the length check, which still exits in production", () => {
  const src = readFileSync(new URL("../src/instrumentation.ts", import.meta.url), "utf8");
  const required = src.match(/const required: string\[\] = \[([^\]]*)\];/);
  assert.ok(required, "the presence list");
  assert.doesNotMatch(required[1], /NEXTAUTH_SECRET/, "the length check below already covers a missing value");
  assert.match(required[1], /"DATABASE_URL"/);
  assert.match(
    src,
    /if \(!secretLongEnough\(process\.env\.NEXTAUTH_SECRET\)\) \{\s*refuse\([\s\S]*?"production",\s*\);/,
  );
});

test("boot refusals: every check is logged first, then ONE exit — always for an always-refusal, production-only otherwise", async () => {
  const { bootRefused } = await import("../src/lib/boot-refusal.ts");
  assert.equal(bootRefused([], "production"), false, "nothing refused");
  assert.equal(bootRefused(["production"], "production"), true);
  assert.equal(bootRefused(["production", "production"], "development"), false, "development keeps running");
  assert.equal(bootRefused(["production", "always"], "development"), true, "an always-refusal exits everywhere");
  assert.equal(bootRefused(["always"], undefined), true);
  const src = readFileSync(new URL("../src/instrumentation.ts", import.meta.url), "utf8");
  assert.match(src, /if \(proxyDecision\.fatal\) \{\s*refuse\(proxyDecision\.message[^,]*, "always"\);/, "the local-only refusal exits in every environment, as before");
  assert.equal((src.match(/process\.exit\(1\)/g) ?? []).length, 2, "the encryption-key exit and the one exit after every check");
});
