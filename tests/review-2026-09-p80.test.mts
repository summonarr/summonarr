// Review 2026-09 / P80 (f133) pinned that the proxy's UA-fingerprint gate went
// through ONE shared helper. Guardrail 6h retired that gate everywhere: the
// User-Agent is written by the client, so comparing it with the fingerprint
// taken at sign-in stopped no replayed cookie and only signed real users out
// when a browser changed its UA. This file now pins the retirement
// structurally — the claim is still minted (informational, and the device
// label comes from the same classification), but nothing reads it back to
// decide anything. The behavioural side (a different UA passes every reader)
// is pinned in tests/session-transport.test.mts and each reader's own file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "generated") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

const rel = (p: string) => p.slice(SRC.length + 1);

// Where the fingerprint claim may appear: its type, the two mints, and the
// re-sign that carries it forward. Anything else touching it is a reader.
const ALLOWED = new Set([
  "lib/session-jwt.ts",
  "lib/auth.ts",
  "app/api/auth/machine-session/route.ts",
  "lib/session-refresh.ts",
]);

test("nothing outside the mint/re-sign touches the uaFingerprint claim (guardrail 6h)", () => {
  const offenders = walk(SRC)
    .filter((f) => /\buaFingerprint\b/.test(readFileSync(f, "utf8")))
    .map(rel)
    .filter((f) => !ALLOWED.has(f));
  assert.deepEqual(offenders, []);
});

test("the mint/re-sign files only WRITE the claim — no `claims.uaFingerprint` read feeds a decision", () => {
  for (const f of ALLOWED) {
    const src = readFileSync(join(SRC, f), "utf8");
    assert.doesNotMatch(src, /claims\.uaFingerprint/, `${f} reads the fingerprint off verified claims`);
  }
});

test("ua-fingerprint.ts exports no comparison, and the session readers never read the User-Agent", () => {
  const lib = readFileSync(join(SRC, "lib/ua-fingerprint.ts"), "utf8");
  assert.doesNotMatch(lib, /export function matches/i, "a stored-vs-request matcher is back");
  for (const f of [
    "proxy.ts",
    "lib/api-auth.ts",
    "lib/cron-auth.ts",
    "lib/session-server.ts",
    "lib/session-refresh.ts",
    "app/api/auth/me/route.ts",
  ]) {
    assert.doesNotMatch(
      readFileSync(join(SRC, f), "utf8"),
      /["']user-agent["']/i,
      `${f} reads the User-Agent — a session reader has no use for it`,
    );
  }
});
