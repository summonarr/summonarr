// The login form's request wiring. The form is a .tsx client component the
// test loader cannot import, so these pins read its source (the
// votes-page-query-shape.test.mts pattern):
//   - a cancelled QuickConnect run ABORTS its requests, so the server frees the
//     long-poll slot (three per IP) at once instead of after 25s;
//   - "QuickConnect is disabled" (the route's quickconnect_disabled marker) and
//     repeated 5xx answers stop the poll with the server's message, rather than
//     polling into the per-secret rate limit;
//   - the OIDC "remember me" box reaches /api/auth/oidc/start;
//   - the Plex client-id adoption runs only when Plex sign-in is offered.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(process.cwd(), "src/app/login/login-form.tsx"), "utf-8");

// The source of one top-level function (or hook / component) by name, up to the
// next top-level declaration. Fails loudly rather than handing a test an empty
// slice that every doesNotMatch would pass.
function topLevel(name: string): string {
  const start = SRC.search(new RegExp(`^(?:export )?(?:async )?function ${name}\\b`, "m"));
  assert.ok(start >= 0, `${name} must be a top-level function in login-form.tsx`);
  const rest = SRC.slice(start + 1);
  const next = rest.search(/^(?:export )?(?:async )?function |^\/\/ /m);
  return next === -1 ? SRC.slice(start) : SRC.slice(start, start + 1 + next);
}

const QC = topLevel("useQuickConnect");

test("QuickConnect: cancelling aborts the run's requests, and both requests carry the run's signal", () => {
  const cancel = QC.slice(QC.indexOf("const cancelQuickConnect = useCallback"), QC.indexOf("useEffect(() => cancelQuickConnect"));
  assert.match(cancel, /qcRunRef\.current \+= 1;/, "the generation check stays");
  assert.match(cancel, /qcAbortRef\.current\?\.abort\(\);/);
  assert.match(QC, /useEffect\(\(\) => cancelQuickConnect, \[cancelQuickConnect\]\);/, "unmount cancels too");
  assert.equal((QC.match(/signal: abort\.signal/g) ?? []).length, 2, "the initiate POST and the long poll");
  assert.match(QC, /cancelQuickConnect\(\);\s*const myRun = qcRunRef\.current;/, "a new run cancels the previous one first");
  assert.match(QC, /if \(abort\.signal\.aborted\) return;/, "an aborted poll ends the run without the retry pause");
  // The post-sign-in re-check survives.
  assert.match(QC, /signInWithFetch\("jellyfin-quickconnect"[\s\S]*?if \(qcRunRef\.current !== myRun\) return;/);
});

test("QuickConnect: the disabled marker and repeated 5xx stop the poll with the server's message", () => {
  assert.match(SRC, /const QC_DISABLED_CODE = "quickconnect_disabled";/);
  assert.match(QC, /body\?\.code === QC_DISABLED_CODE \|\| consecutiveFailures >= QC_MAX_CONSECUTIVE_FAILURES/);
  assert.match(QC, /consecutiveFailures = 0;/, "a good answer resets the count");
});

test("QuickConnect: every tab click remounts the Jellyfin panel, so a click (the active tab's too) cancels the run", () => {
  const form = topLevel("LoginForm");
  assert.match(form, /setPanelGeneration\(\(g\) => g \+ 1\);/);
  assert.match(form, /<JellyfinPanel\s+key=\{panelGeneration\}/);
  assert.match(topLevel("JellyfinPanel"), /useQuickConnect\(/, "the run lives in the panel the key remounts");
});

test("OIDC: the remember-me choice is sent to /api/auth/oidc/start", () => {
  const oidc = topLevel("OidcPanel");
  assert.match(oidc, /<RememberMeCheckbox/);
  assert.match(oidc, /if \(rememberMe\) qp\.set\("rememberMe", "1"\);/);
  assert.match(oidc, /\/api\/auth\/oidc\/start/);
});

test("Plex client-id adoption runs only when Plex sign-in is offered", () => {
  const effect = SRC.slice(SRC.indexOf("// Adopt the server-assigned Plex client ID"));
  const end = effect.indexOf("}, [plexEnabled]);");
  assert.ok(end > 0, "the effect depends on plexEnabled");
  const body = effect.slice(0, end);
  const gate = body.indexOf("if (!plexEnabled) return;");
  assert.ok(gate >= 0 && gate < body.indexOf("fetch("), "gated before the request");
});

// AUTH_URL (the login page's fallback site URL) is a bare origin, and the app is
// served only under BASE_PATH: a return address built from it by hand sent Plex
// back to a 404 on a sub-path install, and /auth/plex/done then redirected to
// the bare origin too. The login flow builds both from the shared helper.
test("Plex sign-in: the return address and the post-sign-in landing carry BASE_PATH", () => {
  const plex = topLevel("PlexPanel");
  assert.match(plex, /const base = plexReturnBase\(siteUrl, window\.location\.origin, BASE_PATH\);/);
  assert.match(plex, /forwardUrl: plexForwardUrl\(base, state\),/);
  assert.match(plex, /siteUrl: base,/, "the done page lands on the base-path root, not the bare origin");
  assert.doesNotMatch(plex, /\(siteUrl \|\| window\.location\.origin\)/, "no hand-built base");
});
