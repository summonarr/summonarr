// Review 2026-09 / P80 (f133): the proxy's UA-fingerprint gate must go through
// the shared matchesStoredFingerprint helper, not an open-coded copy of its
// skip rules. Every other enforcement site (api-auth, auth, cron-auth) already
// does; a second definition in proxy.ts is where a future skip-rule change
// (a new prefix class, say) silently diverges. The behavioural cases —
// mismatch bounce, bearer skip, machine: skip — are pinned in
// tests/proxy.test.mts; this is the structural pin that keeps them all on one
// definition.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const proxySource = readFileSync(
  fileURLToPath(new URL("../src/proxy.ts", import.meta.url)),
  "utf8",
);

test("proxy.ts delegates the UA-fingerprint comparison to matchesStoredFingerprint", () => {
  assert.match(
    proxySource,
    /import \{[^}]*\bmatchesStoredFingerprint\b[^}]*\} from "@\/lib\/ua-fingerprint"/,
    "the shared helper must be imported from @/lib/ua-fingerprint",
  );
  assert.match(
    proxySource,
    /!bearerToken\s*&&\s*!matchesStoredFingerprint\(/,
    "the gate is `!bearerToken && !matchesStoredFingerprint(...)` — bearer skip local, everything else in the helper",
  );
});

test("proxy.ts does not open-code the fingerprint skip rules or the serialize/extract pair", () => {
  assert.doesNotMatch(
    proxySource,
    /startsWith\("machine:"\)/,
    "the machine: exemption has exactly one definition (ua-fingerprint.ts)",
  );
  assert.doesNotMatch(
    proxySource,
    /\b(serializeFingerprint|extractUaFingerprint)\b/,
    "the compare is the helper's job; proxy.ts should not rebuild it from the primitives",
  );
});
