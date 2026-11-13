// The login form's request wiring. The form and its pieces are client modules
// (src/app/login/) the test loader cannot import, so these pins read their
// source (the votes-page-query-shape.test.mts pattern); the answer-reading
// rules themselves are run in tests/login-answers.test.mts:
//   - a cancelled QuickConnect run ABORTS its requests, so the server frees the
//     long-poll slot (three per IP) at once instead of after 25s;
//   - "QuickConnect is disabled" (the route's quickconnect_disabled marker) and
//     repeated 5xx answers stop the poll with the server's message, rather than
//     polling into the per-secret rate limit, while a 429 waits and polls on;
//   - the OIDC "remember me" box reaches /api/auth/oidc/start;
//   - the Plex client-id adoption runs only when Plex sign-in is offered;
//   - the Plex start never throws past its own catch (no hung "Waiting for
//     Plex…"), and builds the approval URL with the shared helper;
//   - the passkey button is busy for the whole ceremony.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (file: string) => readFileSync(join(process.cwd(), "src/app/login", file), "utf-8");
const SRC = read("login-form.tsx");
const QC_SRC = read("use-quick-connect.ts");
const PLEX_SRC = read("plex-sign-in.ts");
const MFA_SRC = read("mfa-step.tsx");

// The source of one top-level function (or hook / component) by name, up to the
// next top-level declaration. Fails loudly rather than handing a test an empty
// slice that every doesNotMatch would pass.
function topLevel(name: string, src = SRC): string {
  const start = src.search(new RegExp(`^(?:export )?(?:async )?function ${name}\\b`, "m"));
  assert.ok(start >= 0, `${name} must be a top-level function`);
  const rest = src.slice(start + 1);
  const next = rest.search(/^(?:export )?(?:async )?function |^\/\/ /m);
  return next === -1 ? src.slice(start) : src.slice(start, start + 1 + next);
}

const QC = topLevel("useQuickConnect", QC_SRC);
const POLL = topLevel("pollUntilAuthenticated", QC_SRC);

test("QuickConnect: cancelling aborts the run's requests, and both requests carry the run's signal", () => {
  const cancel = QC.slice(QC.indexOf("const cancelQuickConnect = useCallback"), QC.indexOf("useEffect(() => cancelQuickConnect"));
  assert.match(cancel, /qcRunRef\.current \+= 1;/, "the generation check stays");
  assert.match(cancel, /qcAbortRef\.current\?\.abort\(\);/);
  assert.match(QC, /useEffect\(\(\) => cancelQuickConnect, \[cancelQuickConnect\]\);/, "unmount cancels too");
  assert.match(QC, /startQuickConnect\(jellyfinInstance, abort\.signal, t\)/, "the initiate POST carries the run's signal");
  assert.match(topLevel("startQuickConnect", QC_SRC), /fetchJson\([\s\S]*?\bsignal,/);
  assert.match(QC, /pollUntilAuthenticated\(started\.secret, jellyfinInstance, abort\.signal, isCurrent, t\)/, "so does the long poll");
  // Bounded as well: one stalled poll must not outlast the run's deadline.
  assert.match(POLL, /timedFetch\(url, \{ signal \}, Math\.max\(1, Math\.min\(QC_POLL_TIMEOUT_MS, deadline - Date\.now\(\)\)\)\)/);
  assert.doesNotMatch(QC_SRC, /[^a-zA-Z]fetch\(url/, "no unbounded poll");
  assert.match(QC, /cancelQuickConnect\(\);\s*const myRun = qcRunRef\.current;/, "a new run cancels the previous one first");
  assert.match(POLL, /if \(signal\.aborted\) return null;/, "an aborted poll ends the run without the retry pause");
  // A network that stays down ends the run with its own message, not the generic timeout.
  assert.match(POLL, /catch \{[\s\S]*?consecutiveFailures \+= 1;\s*if \(consecutiveFailures >= QC_MAX_CONSECUTIVE_FAILURES\) return \{ ok: false, error: t\("auth\.login\.error\.network"\) \};/);
  // The post-sign-in re-check survives.
  assert.match(QC, /signInWithFetch\("jellyfin-quickconnect"[\s\S]*?if \(!isCurrent\(\)\) return;/);
});

test("QuickConnect: the disabled marker and repeated 5xx stop the poll with the server's message; a 429 waits", () => {
  assert.match(POLL, /readQuickConnectPoll\(poll\.status, body, poll\.headers\.get\("Retry-After"\)\)/);
  assert.match(POLL, /case "terminal":\s*return \{ ok: false, error: answer\.message \?\? failed \};/);
  assert.match(POLL, /consecutiveFailures >= QC_MAX_CONSECUTIVE_FAILURES\) return/);
  assert.match(POLL, /consecutiveFailures = 0;/, "a good answer resets the count");
  assert.match(POLL, /case "rateLimited":\s*rateLimited = true;\s*await sleep\(/, "a 429 pauses, then polls on");
  assert.match(POLL, /case "expired":\s*return \{ ok: false, error: answer\.message \?\? t\("auth\.login\.error\.quickConnectExpired"\) \};/);
});

test("QuickConnect: 'Use password instead' clears the run through the hook, not by hand", () => {
  assert.match(topLevel("JellyfinPanel"), /quickConnect\.resetQuickConnect\(\); setJellyfinMode\("password"\);/);
  assert.doesNotMatch(QC, /return \{[^}]*setQcCode/, "the hook does not hand out its setter");
});

test("QuickConnect: every tab click remounts the Jellyfin panel, so a click (the active tab's too) cancels the run", () => {
  const form = topLevel("LoginForm");
  assert.match(form, /setPanelGeneration\(\(g\) => g \+ 1\);/);
  assert.match(form, /<JellyfinPanel\s+key=\{panelGeneration\}/);
  assert.match(topLevel("JellyfinPanel"), /useQuickConnect\(/, "the run lives in the panel the key remounts");
});

// The checkbox and the server select stay on screen while the code is shown.
// What they show must be what the run uses.
test("QuickConnect: the sign-in reads the live remember-me box, and the server select is locked for the run", () => {
  assert.match(QC, /const rememberMeRef = useRef\(rememberMe\);\s*useEffect\(\(\) => \{\s*rememberMeRef\.current = rememberMe;\s*\}, \[rememberMe\]\);/);
  assert.match(QC, /signInWithFetch\("jellyfin-quickconnect", \{ secret: started\.secret, rememberMe: String\(rememberMeRef\.current\) \}\)/);
  assert.match(topLevel("JellyfinPanel"), /<StyledSelect[\s\S]*?disabled=\{jellyfinMode === "quickconnect" && loading\}/);
});

// A password sign-in's answer used to land whatever tab was open by then.
test("Password sign-in: a tab click drops the answer of a sign-in still in flight", () => {
  const form = topLevel("LoginForm");
  const signIn = form.slice(form.indexOf("const signInWithPassword"), form.indexOf("function switchProvider"));
  assert.match(signIn, /signInRunRef\.current \+= 1;\s*const myRun = signInRunRef\.current;/);
  const guard = signIn.indexOf("if (signInRunRef.current !== myRun) return;");
  assert.ok(guard > signIn.indexOf("await signInWithFetch("), "checked after the request");
  for (const effect of ["setMfaChallenge(res.mfa)", "setError(signInFailureMessage(", "await completeSignIn()"]) {
    assert.ok(guard < signIn.indexOf(effect), `${effect} sits behind the check`);
  }
  assert.match(form, /function switchProvider\(next: Provider\) \{\s*signInRunRef\.current \+= 1;/);
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
  assert.ok(gate >= 0 && gate < body.indexOf("fetchJson("), "gated before the request");
});

// AUTH_URL (the login page's fallback site URL) is a bare origin, and the app is
// served only under BASE_PATH: a return address built from it by hand sent Plex
// back to a 404 on a sub-path install, and /auth/plex/done then redirected to
// the bare origin too. The login flow builds both from the shared helper.
test("Plex sign-in: the return address and the post-sign-in landing carry BASE_PATH", () => {
  const plex = topLevel("startPlexSignIn", PLEX_SRC);
  assert.match(plex, /const base = plexReturnBase\(siteUrl, window\.location\.origin, BASE_PATH\);/);
  assert.match(plex, /forwardUrl: plexForwardUrl\(base, state\),/);
  assert.match(plex, /siteUrl: base,/, "the done page lands on the base-path root, not the bare origin");
  assert.doesNotMatch(plex, /\(siteUrl \|\| window\.location\.origin\)/, "no hand-built base");
});

// crypto.randomUUID is undefined on a plain-HTTP origin, and the id and the PIN
// request ran outside any try: the throw left the button on "Waiting for Plex…"
// with no message. Everything that can throw now sits inside the catch.
test("Plex sign-in: the client id, device read and PIN request are inside the catch; the URL is the shared helper's", () => {
  const plex = topLevel("startPlexSignIn", PLEX_SRC);
  const tryBlock = plex.slice(plex.indexOf("try {"), plex.indexOf("} catch {"));
  assert.match(tryBlock, /clientId = getPlexClientId\(\);/);
  assert.match(tryBlock, /deviceMeta = getPlexDeviceMeta\(\);/);
  assert.match(tryBlock, /pin = await createPin\(/);
  assert.match(plex, /const url = plexApprovalUrl\(\{/);
  assert.doesNotMatch(PLEX_SRC, /app\.plex\.tv/, "no hand-built approval URL");
  assert.match(topLevel("createPin", PLEX_SRC), /rateLimitMessage\(res, t\)/, "a 429 names its wait");
  // A stalled start must reject into the catch, so the request is bounded.
  assert.match(topLevel("createPin", PLEX_SRC), /await timedFetch\(withBasePath\("\/api\/auth\/plex\/start"\)/);
  assert.doesNotMatch(PLEX_SRC, /[^a-zA-Z]fetch\(/, "no unbounded request");
  assert.match(topLevel("PlexPanel"), /if \(!started\.ok\) \{\s*setError\(started\.error\);\s*setLoading\(false\);/);
});

test("Second factor: the passkey button is busy for the whole ceremony, and missing options say so", () => {
  const passkey = MFA_SRC.slice(MFA_SRC.indexOf("async function handlePasskey"), MFA_SRC.indexOf("const noMethods"));
  assert.match(passkey, /if \(busy\) return;/);
  assert.match(passkey, /if \(!challenge\.webauthn\) \{[\s\S]*?setError\(t\("auth\.mfa\.error\.passkeyFailed"\)\);/);
  const busyAt = passkey.indexOf("setBusy(true);");
  assert.ok(busyAt >= 0 && busyAt < passkey.indexOf("getPasskeyAssertion("), "busy before the ceremony starts");
});
