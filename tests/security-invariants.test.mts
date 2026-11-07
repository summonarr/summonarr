// Source-level drift pins for three security guardrails that nothing else
// enforces. Types don't catch them, eslint doesn't catch them, and the
// behavioural suite can't: each is an invariant about which call sites are
// ALLOWED to exist, so the regression is always "a new call site was added" —
// invisible in a diff review of the new file alone.
//
// Each rule below has already shipped as a real bug in this codebase at least
// once; the comments name the failure mode rather than restating the rule.
//
// Same idiom as tests/backup-schema.test.mts (schema-vs-manifest drift) and
// tests/app-page-auth-guard.test.mts: read the source, assert the call-site set.
// No DB, no network, no module graph.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(process.cwd(), "src");

function walkTs(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "generated") continue; // Prisma client output — never hand-edited
      walkTs(full, out);
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

const rel = (f: string) => relative(process.cwd(), f).split("\\").join("/");

// Strip `//` line comments before matching. Every prose mention of `fetch()` /
// `encryptToken(...)` in this tree lives in a line comment, so this is what
// keeps the scanners from flagging documentation as a call site.
//
// The `//` inside a scheme ("https://") is NOT a comment. Cutting the line there
// hid every call to the RIGHT of a URL literal from all three scans below —
// `url.startsWith("https://") ? await fetch(url) : null` would have read as a
// comment-only line and sailed through the guardrail-5a pin.
const LINE_COMMENT = /(^|[^:])\/\//;
function codeLines(src: string): string[] {
  return src.split("\n").map((line) => {
    const m = LINE_COMMENT.exec(line);
    return m === null ? line : line.slice(0, m.index + m[1].length);
  });
}

function filesMatching(files: string[], re: RegExp): string[] {
  const hits: string[] = [];
  for (const file of files) {
    if (codeLines(readFileSync(file, "utf-8")).some((l) => re.test(l))) hits.push(rel(file));
  }
  return hits.sort();
}

const allTs = walkTs(SRC);

test("the source walk found a realistic file set — a broken walk must not pass vacuously", () => {
  assert.ok(allTs.length > 400, `expected 400+ source files under src/, got ${allTs.length}`);
});

test("the comment stripper keeps code that follows a URL literal on the same line", () => {
  // Every scan below is only as good as this: a stripper that cuts at "https:"
  // exempts the rest of the line, so the offending call is never even matched.
  assert.match(
    codeLines('const r = url.startsWith("https://") ? await fetch(url) : null;')[0],
    /fetch\(url\)/,
  );
  // …while genuine comments — trailing and whole-line — must still be removed,
  // or every prose mention of fetch()/encryptToken() reads as a call site.
  assert.doesNotMatch(codeLines('const u = "https://x"; // never bare fetch(')[0], /fetch\(/);
  assert.equal(codeLines("// see https://x — never bare fetch(")[0], "");
});

// ── Guardrail 5a/5b: every outbound HTTP call goes through a safe-fetch helper ──

test("guardrail 5a: no bare fetch() in server code outside the documented exceptions", () => {
  // Why: the safe-fetch helpers are where the SSRF policy lives (resolve+pin,
  // RFC1918/loopback/link-local/CGNAT blocking, response-byte caps, timeouts). A
  // bare fetch() to an admin-configured or user-supplied URL bypasses all of it,
  // which is a server-side request forgery primitive — the app holds Plex,
  // Jellyfin, Radarr and Sonarr credentials and sits on the operator's LAN.
  const ALLOWED = new Set([
    // The implementation itself — this IS the wrapped call.
    "src/lib/safe-fetch.ts",
    // Guardrail 5b: the sole internal-loopback exception. Always
    // http://127.0.0.1:${PORT}/api/sync with CRON_SECRET, so the Plex SSE handler
    // drives a real orchestrator run through the same advisory lock + audit path
    // as an external cron.
    "src/lib/internal-trigger.ts",
    // Browser-side helper (imported only by client components) posting chunks to
    // this app's OWN API. No server-side SSRF surface.
    "src/lib/chunked-upload.ts",
  ]);

  const serverFiles = allTs.filter((f) => {
    const r = rel(f);
    return (
      (r.startsWith("src/lib/") || r.startsWith("src/app/api/")) &&
      !r.startsWith("src/lib/client/")
    );
  });

  // `(?<![.\w])` keeps `safeFetch(`, `res.fetch(`, and `prefetch(` out of the match.
  const offenders = filesMatching(serverFiles, /(?<![.\w])fetch\s*\(/).filter(
    (f) => !ALLOWED.has(f),
  );
  assert.deepEqual(
    offenders,
    [],
    "route outbound HTTP through safeFetch (user-supplied URL), safeFetchTrusted " +
      "(hardcoded third-party host + allowedHosts) or safeFetchAdminConfigured " +
      "(URL persisted in Setting) — never bare fetch().",
  );
});

// ── Guardrail 30: every JSON body is size-capped ────────────────────────────

test("guardrail 30: zero bare `await req.json()` in src/app/api", () => {
  // Why: next.config.ts sets proxyClientMaxBodySize as a BACKSTOP, not a
  // per-route limit, so a bare req.json() will happily parse ~20MB. On the
  // anonymous first-run register route — and on any authenticated request/issue/
  // vote route — that is a memory/CPU denial of service for the cost of one POST.
  // readJsonCapped combines a Content-Length fast-reject with a post-read byte
  // check, so a chunked body can't slip past either.
  const apiFiles = allTs.filter((f) => rel(f).startsWith("src/app/api/"));
  const offenders = filesMatching(apiFiles, /await\s+(req|request)\s*\.\s*json\s*\(\s*\)/);
  assert.deepEqual(
    offenders,
    [],
    "use readJsonCapped(req, maxBytes) — or readJsonCappedOr for routes where an " +
      "empty body is valid. Caps: ~16KB single object, 32–64KB text-bearing, ~1MB bulk arrays.",
  );
});

test("guardrail 30: the proxy body buffer sits just above the largest legitimate body", () => {
  // Why: Next clones EVERY non-GET body up to proxyClientMaxBodySize before
  // src/proxy.ts runs — before any auth — so the value is a per-request memory
  // bound for anonymous callers. It was 50mb while nothing needed more than a
  // restore chunk. It must still stay ABOVE the chunk cap: an over-limit body is
  // truncated, not refused, so a cut-off chunk has to land over MAX_CHUNK_BYTES
  // and be rejected rather than fit and be appended corrupt.
  const MiB = 1024 * 1024;
  const config = readFileSync(join(process.cwd(), "next.config.ts"), "utf8");
  const m = /proxyClientMaxBodySize:\s*"(\d+)mb"/.exec(config);
  assert.ok(m, "proxyClientMaxBodySize must be a whole-mb string");
  const proxyLimit = Number(m[1]) * MiB; // Next parses "mb" as 1024*1024 (bytes.parse)
  const chunkCap = (file: string) => {
    const src = readFileSync(join(SRC, file), "utf8");
    const c = /const MAX_CHUNK_BYTES = (\d+) \* 1024 \* 1024;/.exec(src);
    assert.ok(c, `${file}: MAX_CHUNK_BYTES must be a literal N * 1024 * 1024`);
    return Number(c[1]) * MiB;
  };
  const setupCap = chunkCap("app/api/setup/import-chunk/route.ts");
  const adminCap = chunkCap("app/api/admin/backup/db-import-chunk/route.ts");
  const d = /DEFAULT_CHUNK_SIZE = (\d+) \* 1024 \* 1024;/.exec(readFileSync(join(SRC, "lib/chunked-upload.ts"), "utf8"));
  assert.ok(d);
  const clientChunk = Number(d[1]) * MiB;
  assert.equal(setupCap, adminCap, "the two chunk routes share one cap");
  assert.ok(clientChunk <= setupCap, "the client's default chunk must fit the route cap");
  assert.ok(setupCap < proxyLimit, "the proxy limit must stay strictly above the chunk cap");
  assert.ok(proxyLimit <= 24 * MiB, "the proxy buffer must not drift back up for every anonymous POST");
});

test("HSTS covers this host only: includeSubDomains and preload are the operator's call", () => {
  // Why: a self-hosted instance often sits on the operator's own apex or parent
  // domain (https://example.com/request). includeSubDomains forced HTTPS on
  // every sibling subdomain for a year, and preload consented to the browsers'
  // preload list. The value is baked in at build time, so the opt-in lives at
  // the reverse proxy (docker-container/README.md).
  const config = readFileSync(join(process.cwd(), "next.config.ts"), "utf8");
  const m = /key: "Strict-Transport-Security",\s*value: "([^"]*)"/.exec(config);
  assert.ok(m, "the Strict-Transport-Security header");
  assert.match(m[1], /^max-age=\d+$/);
  assert.ok(Number(m[1].slice("max-age=".length)) >= 31536000, "still a year");
  assert.doesNotMatch(m[1], /includeSubDomains|preload/i);
});

// ── Guardrail 7a: the Prisma extension owns Setting/Account encryption ──────

test("guardrail 7a: encryptToken is called only by the extension and the PushSubscription writers", () => {
  // Why: the prisma.ts extension already encrypts Setting.value and
  // Account.{access,refresh,id}_token on every write and decrypts on every read.
  // Pre-encrypting at a call site produces a DOUBLE-wrapped `enc:v1:<enc:v1:…>`
  // row; the extension then decrypts exactly once on read and hands the caller
  // the inner ciphertext, which goes out as a Radarr/Sonarr API key and fails
  // auth. This shipped in bc81802 (a route-level pre-encryption in /api/settings
  // plus an encryptingAdapter in auth.ts) and both were removed afterwards.
  const ALLOWED = new Set([
    // The extension itself — the one place encryption is supposed to happen.
    "src/lib/prisma.ts",
    // PushSubscription is NOT covered by the extension (different table), so
    // these two writers encrypt explicitly. Round-trip pinned in tests/push-routes.
    "src/app/api/push/subscribe/route.ts",
    "src/app/api/push/apns/route.ts",
  ]);
  const offenders = filesMatching(allTs, /(?<![.\w])encryptToken\s*\(/).filter(
    (f) => !ALLOWED.has(f) && f !== "src/lib/token-crypto.ts",
  );
  assert.deepEqual(
    offenders,
    [],
    "never call encryptToken for Setting.value or Account tokens — the prisma.ts " +
      "extension owns that. A third caller means double-encrypted rows at rest.",
  );
});
