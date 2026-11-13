// Profile client components (and the shared sign-out) are modules the unit
// loader can't render, so their wiring is pinned by reading the source.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (rel: string) => readFileSync(new URL(`../src/${rel}`, import.meta.url), "utf8");

// The row came back with a live button until router.refresh() landed, and a
// second click answered "Not found".
test("sessions: a revoked session stays hidden while the page refreshes", () => {
  const src = read("components/profile/auth-sessions.tsx");
  const revoke = src.slice(src.indexOf("async function revoke("), src.indexOf("const visible ="));
  const hide = revoke.indexOf("setRemoved((prev) => new Set(prev).add(sessionId));");
  assert.ok(hide > 0 && hide < revoke.indexOf("router.refresh();"), "hidden before the refresh starts");
  assert.ok(hide > revoke.indexOf("if (res.ok) {"), "only after the revoke succeeded");
  assert.match(src, /const visible = sessions\.filter\(\(s\) => !removed\.has\(s\.sessionId\)\);/);
  assert.match(src, /\{visible\.map\(\(s\) =>/);
  assert.doesNotMatch(src, /\{sessions\.map\(/);
  assert.match(src, /count: visible\.length/);
});

// "Incorrect password." stayed in the prompt after a later try whose password
// was accepted and which failed for another reason.
test("step-up prompts: a failure that is not a password refusal clears the password error", () => {
  const post = read("components/use-step-up-post.ts");
  assert.match(post, /setStepUpError\(null\);\s*setError\(res\.kind === "invalid"/);
  const prefs = read("components/profile/notification-prefs.tsx");
  const send = prefs.slice(prefs.indexOf("async function sendVerification("), prefs.indexOf("async function clearNotificationEmail("));
  assert.match(send, /if \(!res\.ok\) \{[^}]*?setStepUpError\(null\);[^}]*?setEmailError\(/);
  assert.match(send, /catch \{\s*setStepUpError\(null\);\s*setEmailError\(/);
});

// The route refuses an account with no local password and always signs the
// user out on success, so the form has one shape and one way to end.
test("change password: the current password is always sent, and a success always goes to /login", () => {
  const src = read("components/profile/change-password.tsx");
  assert.match(src, /const body: Record<string, unknown> = \{ currentPassword, newPassword \};/);
  assert.match(src, /else if \(out\.kind === "relogin"\) window\.location\.href = withBasePath\("\/login"\);/);
  assert.doesNotMatch(src, /hasPassword \?|hasPassword &&|kind: "saved"|setSuccess/);
  const route = read("app/api/profile/password/route.ts");
  assert.match(route, /if \(user\.passwordHash === null\) \{\s*return NextResponse\.json\(\s*\{ error: t\("apiAuth\.profile\.ssoNoPassword"\) \},\s*\{ status: 403 \},/);
  assert.equal(route.match(/NextResponse\.json\(\{ ok: true[^)]*\)/g)?.join(), "NextResponse.json({ ok: true, requiresRelogin: true })", "the only success answer");
});

// A stalled sign-out POST never reached the redirect.
test("sign-out: the request is bounded and the redirect runs whatever it answered", () => {
  const src = read("components/auth/sign-out.ts");
  assert.match(src, /await timedFetch\(withBasePath\("\/api\/auth\/sign-out"\), \{ method: "POST", credentials: "include" \}, SIGN_OUT_TIMEOUT_MS\);/);
  assert.doesNotMatch(src, /[^a-zA-Z]fetch\(/);
  const tryEnd = src.indexOf("} catch (err) {");
  const after = src.slice(tryEnd);
  assert.match(after, /console\.warn\([^)]*\);\s*\}\s*window\.location\.href = withBasePath\(callbackUrl\);/, "the redirect is after the try, not inside it");
});
