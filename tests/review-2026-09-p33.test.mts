// Review 2026-09 / P33 (f12): scripts/smoke-test.sh documents the ADMIN_COOKIE
// name an operator must export. It used to name the retired NextAuth cookie
// (`__Secure-authjs.session-token`), which the server only ever CLEARS
// (LEGACY_NEXT_AUTH_COOKIE_NAMES in src/lib/session-cookie.ts) and never
// honours — so tests 24/25 of the script could only ever FAIL on a healthy
// deploy. This pins the script's documented names to getSessionCookieName()
// so the two can't drift apart again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getSessionCookieName } from "@/lib/session-cookie.ts";

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
