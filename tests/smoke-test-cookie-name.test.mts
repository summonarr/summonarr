// Review 2026-09 / P33 (f12): scripts/smoke-test.sh documents the ADMIN_COOKIE
// name an operator must export. It used to name the retired NextAuth cookie
// (`__Secure-authjs.session-token`), which the server only ever CLEARS
// (LEGACY_NEXT_AUTH_COOKIE_NAMES in src/lib/session-cookie.ts) and never
// honours — so tests 24/25 of the script could only ever FAIL on a healthy
// deploy. This pins the script's documented names to getSessionCookieName()
// so the two can't drift apart again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTrustedOriginEntry } from "@/lib/trusted-origin.ts";
import { getSessionCookieName } from "@/lib/session-cookie.ts";
import { isAuthRouteExemptFromCsrf, isMachinePath } from "@/lib/proxy-paths.ts";

const script = readFileSync(
  new URL("../scripts/smoke-test.sh", import.meta.url),
  "utf8",
);

function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test("smoke-test.sh documents the live Summonarr session cookie names (f12)", () => {
  const secure = withEnv({ AUTH_URL: "https://requests.example.com" }, () =>
    getSessionCookieName(),
  );
  const insecure = withEnv({ AUTH_URL: "http://localhost:3001" }, () =>
    getSessionCookieName(),
  );
  assert.equal(secure, "__Host-summonarr-session");
  assert.equal(insecure, "summonarr-session");

  // The usage header and the skip hint both name the cookie the server honours.
  assert.match(script, new RegExp(`ADMIN_COOKIE='${secure}=`));
  assert.match(script, new RegExp(`ADMIN_COOKIE='${insecure}=`));
});

test("smoke-test.sh never tells an operator to export a retired NextAuth cookie (f12)", () => {
  // Only the explanatory note may mention the legacy name, and only to say it
  // is no longer honoured — never as the value of ADMIN_COOKIE.
  assert.doesNotMatch(script, /ADMIN_COOKIE='(?:__Secure-|__Host-)?(?:authjs|next-auth)\./);
  // The auth gate is src/proxy.ts; there is no NextAuth authorized() callback.
  assert.doesNotMatch(script, /authorized\(\)/);
  assert.doesNotMatch(script, /NextAuth-default/);
});

// Every curl POST in the script, as [command text, request path].
function scriptPosts(): Array<{ command: string; path: string }> {
  const posts: Array<{ command: string; path: string }> = [];
  const lines = script.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!/curl\b.*-X POST/.test(lines[i])) continue;
    let command = lines[i];
    while (command.endsWith("\\") && i + 1 < lines.length) command += "\n" + lines[++i];
    const path = /"\$URL(\/[^"]*)"/.exec(command)?.[1];
    assert.ok(path, `could not read the path of: ${command}`);
    posts.push({ command, path });
  }
  return posts;
}

test("smoke-test.sh sends an Origin on every POST the proxy origin-checks", () => {
  // The proxy answers 403 to a mutating /api request with no bearer token and
  // no Origin/Referer before it resolves the session, so such a POST can never
  // reach the 401/400 the script asserts.
  const posts = scriptPosts();
  const checked = posts.filter(
    ({ command, path }) =>
      path.startsWith("/api/") &&
      !isAuthRouteExemptFromCsrf(path) &&
      !isMachinePath(path) &&
      !/Authorization: Bearer/.test(command),
  );
  assert.deepEqual(
    checked.map((p) => p.path).sort(),
    ["/api/push/subscribe", "/api/sessions/revoke-all", "/api/sessions/revoke-all"],
  );
  for (const { command, path } of checked) {
    assert.match(command, /-H "Origin: \$ORIGIN"/, `POST ${path} sends no Origin`);
  }
});

// Runs the script's own origin block (nothing else of it) and answers the
// Origin it would send. `envFile` is the .env in the directory it runs from.
function originSent(opts: { target: string; envFile?: string; authUrl?: string }): string {
  const start = script.indexOf("# ── Origin for cookie-style POSTs");
  const end = script.indexOf("# ── Detect docker compose");
  assert.ok(start > 0 && end > start, "origin block not found in smoke-test.sh");
  const dir = mkdtempSync(join(tmpdir(), "smoke-origin-"));
  try {
    if (opts.envFile !== undefined) writeFileSync(join(dir, ".env"), opts.envFile);
    const env: Record<string, string | undefined> = { PATH: process.env.PATH ?? "", URL: opts.target };
    if (opts.authUrl !== undefined) env.AUTH_URL = opts.authUrl;
    return execFileSync(
      "bash",
      ["-c", `set -uo pipefail\n${script.slice(start, end)}\nprintf '%s' "$ORIGIN"`],
      { cwd: dir, env: env as NodeJS.ProcessEnv, encoding: "utf8" },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("smoke-test.sh sends the configured AUTH_URL origin whatever the target is spelled", () => {
  // A server with AUTH_URL set trusts only that origin, so the target's own
  // origin is refused on every direct-to-container address, not only loopback.
  const envFile = "CRON_SECRET=x\nAUTH_URL=https://requests.example.com\n";
  for (const target of [
    "http://localhost:3001",
    "http://192.168.1.50:3001",
    "http://[::1]:3001",
    "http://0.0.0.0:3001",
    "http://summonarr:3000",
    "https://localhost",
  ]) {
    assert.equal(originSent({ target, envFile }), "https://requests.example.com", target);
  }
  // No AUTH_URL anywhere: the server trusts the request's own origin.
  assert.equal(originSent({ target: "http://192.168.1.50:3001/" }), "http://192.168.1.50:3001");
  assert.equal(
    originSent({ target: "http://192.168.1.50:3001", envFile: "CRON_SECRET=x\n" }),
    "http://192.168.1.50:3001",
  );
});

test("smoke-test.sh derives the Origin the way the server derives its trusted origin", () => {
  const target = "http://localhost:3001";
  for (const authUrl of [
    "https://Requests.Example.com",
    "HTTPS://requests.example.com:443",
    "http://Requests.Example.com:80/",
    "https://requests.example.com:8443/base/path?x=1",
    "https://requests.example.com/",
    "http://[::1]:80",
  ]) {
    const want = parseTrustedOriginEntry(authUrl);
    assert.ok(want, authUrl);
    assert.equal(originSent({ target, authUrl }), want, `env ${authUrl}`);
    for (const line of [
      `AUTH_URL=${authUrl}\n`,
      `AUTH_URL=${authUrl}\r\n`,
      `AUTH_URL="${authUrl}"\r\n`,
      `AUTH_URL='${authUrl}' # public address\n`,
      `AUTH_URL=${authUrl} # public address\n`,
    ]) {
      assert.equal(originSent({ target, envFile: line }), want, JSON.stringify(line));
    }
  }
  // A value the server cannot use as an origin is not sent as one.
  assert.equal(originSent({ target, authUrl: "requests.example.com:3001" }), target);
});
