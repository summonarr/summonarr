// The proxy's path classifiers (src/lib/proxy-paths.ts): which paths are
// public, which are machine endpoints, and which auth routes skip the CSRF
// Origin check. These are exemptions, so they match exactly and on whole path
// segments. The proxy's use of them is pinned in tests/proxy.test.mts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isAuthRouteExemptFromCsrf, isMachinePath, isPublicPath, isUnderPath } from "../src/lib/proxy-paths.ts";

test("isUnderPath: the path itself or something below it, never a longer name", () => {
  assert.equal(isUnderPath("/login", "/login"), true);
  assert.equal(isUnderPath("/login/", "/login"), true);
  assert.equal(isUnderPath("/login/callback", "/login"), true);
  assert.equal(isUnderPath("/login-history", "/login"), false);
  assert.equal(isUnderPath("/loginx", "/login"), false);
  assert.equal(isUnderPath("/", "/login"), false);
});

test("the public pages cover their own subtree only", () => {
  for (const path of ["/login", "/register", "/setup", "/auth/plex", "/auth/plex/done", "/setup/step-2"]) {
    assert.equal(isPublicPath(path), true, `${path} is public`);
  }
  for (const path of ["/login-history", "/registered-devices", "/setup-wizard", "/auth/plexus", "/auth", "/movies"]) {
    assert.equal(isPublicPath(path), false, `${path} only looks like a public page`);
  }
});

test("public API paths, machine paths and the anonymous resources stay public", () => {
  for (const path of [
    "/api/auth/sign-in",
    "/api/setup/import",
    "/api/health",
    "/api/config/compat",
    "/api/profile/notification-email/confirm",
    "/api/calendar/feed/abc.ics",
    "/api/webhooks/radarr",
    "/api/sync",
    "/api/sync/plex",
    "/api/cron/warm-activity",
    "/api/interactions",
    "/.well-known/security.txt",
    "/robots.txt",
  ]) {
    assert.equal(isPublicPath(path), true, `${path} is public`);
  }
  for (const path of ["/api/syncx", "/api/calendar/other", "/api/profile/calendar", "/api/healthz", "/api/interactions/x"]) {
    assert.equal(isPublicPath(path), false, `${path} is gated`);
  }
});

test("exemptions match the path exactly as sent — a mis-cased path is never exempt", () => {
  assert.equal(isPublicPath("/Login"), false);
  assert.equal(isMachinePath("/API/sync"), false);
  assert.equal(isMachinePath("/api/Webhooks/radarr"), false);
  assert.equal(isAuthRouteExemptFromCsrf("/api/auth/OIDC/callback"), false);
});

test("only the three Origin-less auth routes skip the CSRF check", () => {
  for (const path of ["/api/auth/oidc/callback", "/api/auth/oidc/start", "/api/auth/machine-session"]) {
    assert.equal(isAuthRouteExemptFromCsrf(path), true);
  }
  for (const path of ["/api/auth/sign-in", "/api/auth/sign-out", "/api/auth/register", "/api/auth/oidc/callback/x"]) {
    assert.equal(isAuthRouteExemptFromCsrf(path), false);
  }
});
