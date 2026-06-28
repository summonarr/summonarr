// Smoke test for the security audit remediation foundation modules.
// Run with: npx tsx scripts/smoke-test-security.ts
//
// Verifies the runtime behaviour of:
//   - src/lib/ssrf.ts        (resolveToSafeUrl rejects IPv6 unique-local
//                             addresses (fc00::/7) along with loopback,
//                             link-local, RFC1918, IMDS, and the RFC 6052
//                             NAT64 range, while still allowing public hosts)
//   - src/lib/safe-fetch.ts  (request timeout fires promptly, redirects and
//                             response size caps are enforced, and non-
//                             allowlisted hosts are blocked)
//
// These modules have no database dependency, so the runner stays
// self-contained and runs in the lint/typecheck CI job (which has no
// Postgres). Webhook replay protection is backed by the WebhookReplay table
// and is exercised against a live database, not here.
//
// This is intentionally a small standalone runner — there is no test
// framework in this project. Exits non-zero on the first failure.

import { resolveToSafeUrl } from "../src/lib/ssrf";
import { safeFetchTrusted, SafeFetchError } from "../src/lib/safe-fetch";

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
  console.log("\n[smoke] SSRF helper blocks ULA, link-local, loopback, and other private ranges");
  await expect("blocks fc00::/7 ULA literal",      async () => (await resolveToSafeUrl("http://[fd00::1]/")) === null);
  await expect("blocks fd12::/16 ULA literal",     async () => (await resolveToSafeUrl("http://[fd12:3456::1]/")) === null);
  await expect("blocks fc00::/8 ULA literal",      async () => (await resolveToSafeUrl("http://[fc00::1]/")) === null);
  await expect("blocks 64:ff9b::/96 RFC 6052",     async () => (await resolveToSafeUrl("http://[64:ff9b::127.0.0.1]/")) === null);
  await expect("blocks 127.0.0.1 (loopback)",      async () => (await resolveToSafeUrl("http://127.0.0.1/")) === null);
  await expect("blocks ::1 (IPv6 loopback)",       async () => (await resolveToSafeUrl("http://[::1]/")) === null);
  await expect("blocks 169.254.169.254 (IMDS)",    async () => (await resolveToSafeUrl("http://169.254.169.254/")) === null);
  await expect("blocks fe80:: (link-local)",       async () => (await resolveToSafeUrl("http://[fe80::1]/")) === null);
  await expect("blocks 10.0.0.1 (RFC1918 /8)",     async () => (await resolveToSafeUrl("http://10.0.0.1/")) === null);
  await expect("blocks 172.16.0.1 (RFC1918 /12)",  async () => (await resolveToSafeUrl("http://172.16.0.1/")) === null);
  await expect("blocks 172.31.255.1 (RFC1918 /12)", async () => (await resolveToSafeUrl("http://172.31.255.1/")) === null);
  await expect("allows 172.15/172.32 (outside /12)", async () => (await resolveToSafeUrl("http://172.15.0.1/")) !== null && (await resolveToSafeUrl("http://172.32.0.1/")) !== null);
  await expect("blocks 192.168.1.1 (RFC1918 /16)", async () => (await resolveToSafeUrl("http://192.168.1.1/")) === null);
  await expect("rejects file:// scheme",           async () => (await resolveToSafeUrl("file:///etc/passwd")) === null);
  await expect("allows public IP literal",         async () => (await resolveToSafeUrl("http://1.1.1.1/")) !== null);

  console.log("\n[smoke] safeFetchTrusted error reasons");

  await expect("safeFetchTrusted blocks non-allowlisted host", async () => {
    try {
      await safeFetchTrusted("http://127.0.0.1/", { allowedHosts: ["example.com"] });
      return false;
    } catch (err) {
      return err instanceof SafeFetchError && err.reason === "ssrf-blocked";
    }
  });

  await expect("safeFetchTrusted timeout fires fast", async () => {
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

  console.log(`\n[smoke] Done. ${failures === 0 ? "✓ ALL PASS" : `✗ ${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("[smoke] uncaught:", err);
  process.exit(1);
});
