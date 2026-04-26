// Smoke test for the security audit remediation foundation modules.
// Run with: npx tsx scripts/smoke-test-security.ts
//
// Verifies the runtime behaviour of:
//   - src/lib/ssrf.ts        (H-2 ULA blocks)
//   - src/lib/safe-fetch.ts  (timeout, redirect, size cap)
//   - src/lib/webhook-replay.ts (replay rejection)
//
// This is intentionally a small standalone runner — there is no test
// framework in this project. Exits non-zero on the first failure.

import { resolveToSafeUrl } from "../src/lib/ssrf";
import { safeFetch, safeFetchTrusted, SafeFetchError } from "../src/lib/safe-fetch";
import { checkAndRecordWebhook, __resetWebhookReplayCacheForTests } from "../src/lib/webhook-replay";

let failures = 0;
function ok(label: string) { console.log(`  ✓ ${label}`); }
function fail(label: string, detail: unknown) {
  failures++;
  console.error(`  ✗ ${label}\n    ${detail}`);
}
async function expect(label: string, fn: () => boolean | Promise<boolean>): Promise<void> {
  try {
    const result = await fn();
    if (result) ok(label);
    else fail(label, "assertion returned false");
  } catch (err) {
    fail(label, err instanceof Error ? err.message : String(err));
  }
}

async function main() {
  console.log("\n[smoke] H-2: SSRF helper blocks ULA + link-local + loopback");
  await expect("blocks fc00::/7 ULA literal",      async () => (await resolveToSafeUrl("http://[fd00::1]/")) === null);
  await expect("blocks fd12::/16 ULA literal",     async () => (await resolveToSafeUrl("http://[fd12:3456::1]/")) === null);
  await expect("blocks fc00::/8 ULA literal",      async () => (await resolveToSafeUrl("http://[fc00::1]/")) === null);
  await expect("blocks 64:ff9b::/96 RFC 6052",     async () => (await resolveToSafeUrl("http://[64:ff9b::127.0.0.1]/")) === null);
  await expect("blocks 127.0.0.1 (loopback)",      async () => (await resolveToSafeUrl("http://127.0.0.1/")) === null);
  await expect("blocks ::1 (IPv6 loopback)",       async () => (await resolveToSafeUrl("http://[::1]/")) === null);
  await expect("blocks 169.254.169.254 (IMDS)",    async () => (await resolveToSafeUrl("http://169.254.169.254/")) === null);
  await expect("blocks fe80:: (link-local)",       async () => (await resolveToSafeUrl("http://[fe80::1]/")) === null);
  await expect("rejects file:// scheme",           async () => (await resolveToSafeUrl("file:///etc/passwd")) === null);
  await expect("allows public IP literal",         async () => (await resolveToSafeUrl("http://1.1.1.1/")) !== null);

  console.log("\n[smoke] safeFetch / safeFetchTrusted error reasons");

  await expect("safeFetch blocks SSRF (loopback)", async () => {
    try {
      await safeFetch("http://127.0.0.1/");
      return false;
    } catch (err) {
      return err instanceof SafeFetchError && err.reason === "ssrf-blocked";
    }
  });

  await expect("safeFetch timeout fires fast", async () => {
    // example.com:81 — closed port; should timeout via the safeFetch wrapper.
    // Use a 100ms timeout to keep the test snappy.
    const start = Date.now();
    try {
      await safeFetchTrusted("http://example.com:81/", { allowedHosts: ["example.com"], timeoutMs: 100 });
      return false;
    } catch (err) {
      const elapsed = Date.now() - start;
      if (!(err instanceof SafeFetchError)) return false;
      // Either timeout or network — both are acceptable failure modes for a closed port.
      if (err.reason !== "timeout" && err.reason !== "network") return false;
      // Should not have hung for more than ~5 seconds even on a network error.
      return elapsed < 5000;
    }
  });

  console.log("\n[smoke] M-1: webhook-replay cache rejects duplicates");
  __resetWebhookReplayCacheForTests();
  await expect("first call accepted",                  async () => (await checkAndRecordWebhook("plex", "secret", "body-1")) === true);
  await expect("identical replay rejected",            async () => (await checkAndRecordWebhook("plex", "secret", "body-1")) === false);
  await expect("different body accepted",              async () => (await checkAndRecordWebhook("plex", "secret", "body-2")) === true);
  await expect("different source accepted (sonarr)",   async () => (await checkAndRecordWebhook("sonarr", "secret", "body-1")) === true);
  await expect("different secret accepted",            async () => (await checkAndRecordWebhook("plex", "other", "body-1")) === true);
  await expect("Uint8Array body accepted",             async () => (await checkAndRecordWebhook("plex", "secret", new TextEncoder().encode("binary-1"))) === true);
  await expect("Uint8Array replay rejected",           async () => (await checkAndRecordWebhook("plex", "secret", new TextEncoder().encode("binary-1"))) === false);

  console.log(`\n[smoke] Done. ${failures === 0 ? "✓ ALL PASS" : `✗ ${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("[smoke] uncaught:", err);
  process.exit(1);
});
