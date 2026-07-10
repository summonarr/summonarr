// Unit tests for the pure/pre-network parts of the SSRF wrapper
// (src/lib/safe-fetch.ts) — the single chokepoint for ALL outbound HTTP
// (guardrail 5a). These pin the behaviors that decide whether a request is
// even allowed to reach the network: URL/protocol pre-checks, the required
// allowedHosts matching in safeFetchTrusted, the per-mode SSRF policy
// (allowPrivate), and the SafeFetchError log-redaction contract (upstream
// URLs carry secrets in query strings — Plex ?X-Plex-Token=, OMDb ?apikey=).
//
// No test here performs DNS or network I/O: every input is either rejected
// before the resolve step, or uses an IP-literal hostname, which
// resolveToSafeUrlWithAddrs/verifyResolvedHost short-circuit via net.isIP
// without a dns.lookup. Paths that would PASS the policy (and thus call
// fetch()) are deliberately never exercised.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  safeFetch,
  safeFetchTrusted,
  safeFetchAdminConfigured,
  SafeFetchError,
  redactUrlForLog,
} from "../src/lib/safe-fetch.ts";

// Await a safe-fetch promise and return the SafeFetchError it MUST reject
// with — failing loudly if it resolved (i.e. a network call was attempted).
async function captureError(p: Promise<Response>): Promise<SafeFetchError> {
  try {
    await p;
  } catch (err) {
    assert.ok(
      err instanceof SafeFetchError,
      `expected SafeFetchError, got: ${String(err)}`,
    );
    return err;
  }
  assert.fail("expected rejection before any network I/O, but the promise resolved");
}

// ---------------------------------------------------------------------------
// redactUrlForLog
// ---------------------------------------------------------------------------

test("redactUrlForLog strips the query string (where upstream secrets live)", () => {
  assert.equal(
    redactUrlForLog("https://plex.tv/library/sections?X-Plex-Token=s3cret"),
    "https://plex.tv/library/sections",
  );
  assert.equal(
    redactUrlForLog("https://www.omdbapi.com/?apikey=abcd1234&t=Heat"),
    "https://www.omdbapi.com/",
  );
});

test("redactUrlForLog strips embedded credentials but keeps path and fragment", () => {
  assert.equal(
    redactUrlForLog("https://user:hunter2@example.com/a/b?q=1#frag"),
    "https://example.com/a/b#frag",
  );
});

test("redactUrlForLog returns the sentinel for unparseable input", () => {
  assert.equal(redactUrlForLog("not a url"), "[unparseable-url]");
  assert.equal(redactUrlForLog(""), "[unparseable-url]");
  assert.equal(redactUrlForLog("//protocol-relative.example/x"), "[unparseable-url]");
});

// ---------------------------------------------------------------------------
// SafeFetchError — every instance must be safe to log verbatim
// ---------------------------------------------------------------------------

test("SafeFetchError shape: name, reason, redacted url, Error inheritance", () => {
  const err = new SafeFetchError("timeout", "https://api.example.com/v1?apikey=TOPSECRET", "boom");
  assert.ok(err instanceof Error);
  assert.equal(err.name, "SafeFetchError");
  assert.equal(err.reason, "timeout");
  assert.equal(err.url, "https://api.example.com/v1");
  assert.equal(err.message, "boom");
});

test("SafeFetchError scrubs every occurrence of the raw URL from the message", () => {
  const raw = "https://api.example.com/v1?apikey=TOPSECRET";
  const err = new SafeFetchError("network", raw, `fetch failed for ${raw}; will not retry ${raw}`);
  assert.equal(
    err.message,
    "fetch failed for https://api.example.com/v1; will not retry https://api.example.com/v1",
  );
  assert.ok(!err.message.includes("TOPSECRET"));
  assert.ok(!err.url.includes("TOPSECRET"));
});

test("SafeFetchError with an unparseable url uses the sentinel in url and message", () => {
  const err = new SafeFetchError("ssrf-blocked", "::garbage::", "Invalid URL: ::garbage::");
  assert.equal(err.url, "[unparseable-url]");
  assert.equal(err.message, "Invalid URL: [unparseable-url]");
});

test("SafeFetchError with an empty url leaves the message untouched", () => {
  // `url && safeUrl !== url` guards the split/join — an empty url must not
  // trigger a degenerate ''.split('') scrub that would mangle the message.
  const err = new SafeFetchError("network", "", "fetch failed");
  assert.equal(err.message, "fetch failed");
  assert.equal(err.url, "[unparseable-url]");
});

test("SafeFetchError leaves an already-clean URL and message unchanged", () => {
  const raw = "https://api.example.com/v1/movies";
  const err = new SafeFetchError("size", raw, `Response body exceeded cap for ${raw}`);
  assert.equal(err.url, raw);
  assert.equal(err.message, `Response body exceeded cap for ${raw}`);
});

// ---------------------------------------------------------------------------
// URL pre-checks — reject before any DNS/network, on all three entry points
// ---------------------------------------------------------------------------

test("all three entry points reject an unparseable URL as ssrf-blocked", async () => {
  for (const p of [
    safeFetch("not-a-url"),
    safeFetchAdminConfigured("not-a-url"),
    safeFetchTrusted("not-a-url", { allowedHosts: ["api.example.com"] }),
  ]) {
    const err = await captureError(p);
    assert.equal(err.reason, "ssrf-blocked");
    assert.equal(err.message, "Invalid URL: [unparseable-url]");
    assert.equal(err.url, "[unparseable-url]");
  }
});

test("non-http(s) protocols are rejected before any resolution", async () => {
  const cases: Array<[string, string]> = [
    ["file:///etc/passwd", "file:"],
    ["ftp://203.0.113.7/pub", "ftp:"],
    ["javascript:alert(1)", "javascript:"],
    ["data:text/plain,hi", "data:"],
  ];
  for (const [url, proto] of cases) {
    const err = await captureError(safeFetch(url));
    assert.equal(err.reason, "ssrf-blocked");
    assert.equal(err.message, `Protocol not allowed: ${proto}`);
  }
  // Same check applies in admin mode — allowPrivate never relaxes the scheme.
  const adminErr = await captureError(safeFetchAdminConfigured("file:///etc/passwd"));
  assert.equal(adminErr.message, "Protocol not allowed: file:");
});

test("protocol check runs before the allowedHosts check in trusted mode", async () => {
  // A bad scheme must be reported as a protocol violation, not fall through to
  // (or be masked by) allowlist validation.
  const err = await captureError(
    safeFetchTrusted("gopher://api.example.com/", { allowedHosts: [] }),
  );
  assert.equal(err.message, "Protocol not allowed: gopher:");
});

// ---------------------------------------------------------------------------
// safeFetchTrusted — allowedHosts matching / validation (fail-closed)
// ---------------------------------------------------------------------------

test("safeFetchTrusted rejects an empty allowedHosts list (fail-closed)", async () => {
  const err = await captureError(
    safeFetchTrusted("https://api.example.com/v1", { allowedHosts: [] }),
  );
  assert.equal(err.reason, "ssrf-blocked");
  assert.equal(err.message, "safeFetchTrusted requires a non-empty allowedHosts list");
});

test("safeFetchTrusted rejects a host not in the allowlist, pre-DNS", async () => {
  const err = await captureError(
    safeFetchTrusted("https://evil.example/steal", { allowedHosts: ["api.themoviedb.org"] }),
  );
  assert.equal(err.reason, "ssrf-blocked");
  assert.equal(
    err.message,
    "URL blocked by trusted-host policy (host=evil.example): https://evil.example/steal",
  );
});

test("allowlist matching is exact: subdomains and lookalikes do not match", async () => {
  for (const url of [
    "https://sub.example.com/x",
    "https://evil-example.com/x",
    "https://example.com.evil.example/x",
  ]) {
    const err = await captureError(
      safeFetchTrusted(url, { allowedHosts: ["example.com"] }),
    );
    assert.equal(err.reason, "ssrf-blocked");
    assert.match(err.message, /blocked by trusted-host policy/);
  }
});

test("userinfo trick cannot spoof the allowlist (host@real-target)", async () => {
  // URL hostname is 10.0.0.1; the allowlisted name only appears as userinfo.
  const err = await captureError(
    safeFetchTrusted("http://api.themoviedb.org@10.0.0.1/x", {
      allowedHosts: ["api.themoviedb.org"],
    }),
  );
  assert.equal(err.reason, "ssrf-blocked");
  assert.match(err.message, /trusted-host policy \(host=10\.0\.0\.1\)/);
});

test("allowlist match ignores the port; an entry containing a port never matches", async () => {
  // hostname excludes the port, so "10.0.0.1" matches http://10.0.0.1:7878 —
  // proven by it getting PAST the allowlist to the SSRF resolve check (which
  // then blocks the private literal under allowPrivate=false, still no DNS).
  const matched = await captureError(
    safeFetchTrusted("http://10.0.0.1:7878/api/v3", { allowedHosts: ["10.0.0.1"] }),
  );
  assert.match(matched.message, /trusted host resolves to unsafe address/);

  // An allowlist entry written WITH a port can never match any hostname.
  const unmatched = await captureError(
    safeFetchTrusted("http://10.0.0.1:7878/api/v3", { allowedHosts: ["10.0.0.1:7878"] }),
  );
  assert.match(unmatched.message, /blocked by trusted-host policy/);
});

test("allowlist entries are case-folded to match the lowercased URL hostname", async () => {
  // [FD00::1] in the allowlist must match the parser-lowercased [fd00::1]
  // hostname — proven by getting past the allowlist to the SSRF check, which
  // blocks the ULA literal (a non-match would say "trusted-host policy").
  const err = await captureError(
    safeFetchTrusted("http://[FD00::1]/x", { allowedHosts: ["[FD00::1]"] }),
  );
  assert.equal(err.reason, "ssrf-blocked");
  assert.match(err.message, /trusted host resolves to unsafe address/);
});

test("trusted mode enforces allowPrivate=false even for allowlisted hosts", async () => {
  // A trusted host must never be backed by a private/loopback address —
  // this is the DNS-rebind defence; IP literals shortcut it deterministically.
  for (const host of ["127.0.0.1", "10.1.2.3", "192.168.0.10", "169.254.169.254"]) {
    const err = await captureError(
      safeFetchTrusted(`http://${host}/v1`, { allowedHosts: [host] }),
    );
    assert.equal(err.reason, "ssrf-blocked");
    assert.match(err.message, /trusted host resolves to unsafe address/);
  }
});

// ---------------------------------------------------------------------------
// safeFetch (user mode, allowPrivate=false) — full SSRF policy
// ---------------------------------------------------------------------------

test("safeFetch blocks private/special IPv4 literals", async () => {
  const blocked = [
    "http://127.0.0.1/x", // loopback
    "http://127.8.9.10/x", // whole 127/8
    "http://10.0.0.1/x", // RFC1918 10/8
    "http://172.16.0.1/x", // RFC1918 172.16/12 low edge
    "http://172.31.255.255/x", // RFC1918 172.16/12 high edge
    "http://192.168.1.1/x", // RFC1918 192.168/16
    "http://100.64.0.1/x", // CGNAT 100.64/10
    "http://169.254.169.254/latest/meta-data", // link-local / cloud metadata
    "http://0.0.0.0/x", // unspecified
    "http://224.0.0.251/x", // multicast
    "http://255.255.255.255/x", // broadcast/reserved
    "HTTP://127.0.0.1/x", // scheme case-normalized, still blocked
  ];
  for (const url of blocked) {
    const err = await captureError(safeFetch(url));
    assert.equal(err.reason, "ssrf-blocked", `expected ${url} to be ssrf-blocked`);
    assert.match(err.message, /URL blocked by SSRF policy/);
  }
});

test("safeFetch blocks private/special IPv6 literals, including v4-mapped forms", async () => {
  const blocked = [
    "http://[::1]/x", // loopback
    "http://[::]/x", // unspecified
    "http://[fe80::1]/x", // link-local
    "http://[fd00::1]/x", // ULA fc00::/7
    "http://[fc00::1]/x", // ULA low edge
    "http://[::ffff:127.0.0.1]/x", // v4-mapped loopback (dotted)
    "http://[::ffff:7f00:1]/x", // v4-mapped loopback (hex pair)
    "http://[::ffff:c0a8:101]/x", // v4-mapped 192.168.1.1
    "http://[64:ff9b::a00:1]/x", // NAT64-embedded 10.0.0.1
    "http://[ff02::1]/x", // multicast
  ];
  for (const url of blocked) {
    const err = await captureError(safeFetch(url));
    assert.equal(err.reason, "ssrf-blocked", `expected ${url} to be ssrf-blocked`);
  }
});

test("decimal/hex/short IPv4 spellings are normalized by the URL parser, then blocked", async () => {
  // WHATWG URL canonicalizes these to 127.0.0.1 before the policy runs, so
  // numeric-obfuscation bypasses never reach a different code path.
  for (const url of ["http://2130706433/x", "http://0x7f000001/x", "http://127.1/x"]) {
    const err = await captureError(safeFetch(url));
    assert.equal(err.reason, "ssrf-blocked");
    assert.equal(err.url, "http://127.0.0.1/x");
  }
});

test("blocked-request errors never leak query-string or userinfo secrets", async () => {
  const err = await captureError(
    safeFetch("http://svc:hunter2@192.168.1.10/hook?token=supersecret"),
  );
  assert.equal(err.reason, "ssrf-blocked");
  assert.equal(err.url, "http://192.168.1.10/hook");
  assert.ok(!err.message.includes("supersecret"));
  assert.ok(!err.message.includes("hunter2"));
});

// ---------------------------------------------------------------------------
// safeFetchAdminConfigured (allowPrivate=true) — link-local/unspecified stay blocked
// ---------------------------------------------------------------------------

test("admin mode still blocks link-local, unspecified, and site-local addresses", async () => {
  const blocked = [
    "http://169.254.169.254/latest/meta-data", // cloud metadata endpoint
    "http://[fe80::1]:8096/", // IPv6 link-local
    "http://[::ffff:169.254.169.254]/", // v4-mapped link-local
    "http://0.0.0.0:7878/", // unspecified v4
    "http://[::]:8989/", // unspecified v6
    "http://[fec0::1]/", // deprecated site-local
  ];
  for (const url of blocked) {
    const err = await captureError(safeFetchAdminConfigured(url));
    assert.equal(err.reason, "ssrf-blocked", `expected ${url} to be ssrf-blocked in admin mode`);
    assert.match(err.message, /URL blocked by SSRF policy/);
  }
});
