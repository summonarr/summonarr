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
function codeLines(src: string): string[] {
  return src.split("\n").map((line) => {
    const i = line.indexOf("//");
    return i === -1 ? line : line.slice(0, i);
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
  // Why: next.config.ts sets proxyClientMaxBodySize: "50mb" as a BACKSTOP, not a
  // per-route limit, so a bare req.json() will happily parse 50MB. On the
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
