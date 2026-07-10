// Unit tests for the in-memory force-revocation ledger
// (src/lib/session-revocation.ts). verifyAndRefreshSession skips the DB
// revocation lookup inside a short dbCheckedAt cache window; these sets close
// that window on the replica that issued a revoke, so "revoke this device" /
// "log out everywhere" takes effect on the next request instead of up to 60s
// later. Properties that must hold: marks are never consumed on read (a cached
// token can be replayed several times), session and user marks are independent
// namespaces, and both sets are FIFO-bounded at 1024 entries so a long-lived
// process can't grow them unboundedly (auth#34). Per guardrail 27 the callers
// mark AFTER the DB write succeeds — that ordering lives in the callers
// (auth.ts, revoke routes), not here; this file pins the ledger itself.
//
// The two sets are module-level singletons, so each eviction test floods with
// its own unique key prefix to build its full state from scratch rather than
// depending on what earlier tests inserted.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  markUserForceRevalidate,
  markSessionForceRevoked,
  shouldForceDbCheck,
} from "../src/lib/session-revocation.ts";

// Mirrors FORCE_REVOKE_MAX in the module (not exported).
const CAP = 1024;

test("unmarked user + session never forces a DB check (baseline)", () => {
  assert.equal(shouldForceDbCheck("u_never_marked", "sess_never_marked"), false);
  // Empty strings are ordinary Set keys — unmarked they must also read false.
  assert.equal(shouldForceDbCheck("", ""), false);
});

test("markSessionForceRevoked forces the check for that sessionId under any userId", () => {
  markSessionForceRevoked("sess_revoked_1");
  // The session mark matches regardless of which user carries the token.
  assert.equal(shouldForceDbCheck("u_owner", "sess_revoked_1"), true);
  assert.equal(shouldForceDbCheck("u_someone_else", "sess_revoked_1"), true);
  // Sibling sessions of the same user are untouched — "revoke this device"
  // must not degrade the fast path for the user's other devices.
  assert.equal(shouldForceDbCheck("u_owner", "sess_sibling"), false);
});

test("markUserForceRevalidate forces the check for that userId under any sessionId", () => {
  markUserForceRevalidate("u_revoked_everywhere");
  // "Log out everywhere": every session of the user is forced to the DB.
  assert.equal(shouldForceDbCheck("u_revoked_everywhere", "sess_a"), true);
  assert.equal(shouldForceDbCheck("u_revoked_everywhere", "sess_b"), true);
  // Other users keep their fast path.
  assert.equal(shouldForceDbCheck("u_unrelated", "sess_a"), false);
});

test("marks are never consumed on read — replayed tokens keep hitting the DB", () => {
  markSessionForceRevoked("sess_replayed");
  markUserForceRevalidate("u_replayed");
  // A cached token may be presented many times before the DB rejects it, so
  // the force-check must survive every read (the module deliberately has no
  // "clear" API — only FIFO eviction reclaims entries).
  for (let i = 0; i < 5; i++) {
    assert.equal(shouldForceDbCheck("u_x", "sess_replayed"), true);
    assert.equal(shouldForceDbCheck("u_replayed", `sess_${i}`), true);
  }
});

test("session and user marks are independent namespaces for the same string", () => {
  // Marking a value as a *session* must not make it match as a *user* — a
  // colliding id (or an attacker-chosen one) must not widen a single-device
  // revoke into a whole-account slow path, or vice versa.
  markSessionForceRevoked("shared_id_1");
  assert.equal(shouldForceDbCheck("shared_id_1", "sess_other"), false);
  markUserForceRevalidate("shared_id_2");
  assert.equal(shouldForceDbCheck("u_other", "shared_id_2"), false);
});

test("session ledger is FIFO-bounded at 1024: oldest entry is evicted first", () => {
  // Build a full, known state with a unique prefix. The sentinel goes in
  // first; 1024 subsequent inserts must push out everything older than the
  // flood (each insert past capacity evicts exactly one oldest entry).
  markSessionForceRevoked("evict_a:sentinel");
  for (let i = 0; i < CAP; i++) markSessionForceRevoked(`evict_a:${i}`);
  assert.equal(shouldForceDbCheck("u", "evict_a:sentinel"), false);
  // The flood itself fully survives — it is exactly at capacity.
  assert.equal(shouldForceDbCheck("u", "evict_a:0"), true);
  assert.equal(shouldForceDbCheck("u", `evict_a:${CAP - 1}`), true);
  // One more insert evicts precisely the oldest flood entry, nothing else.
  markSessionForceRevoked("evict_a:one-more");
  assert.equal(shouldForceDbCheck("u", "evict_a:0"), false);
  assert.equal(shouldForceDbCheck("u", "evict_a:1"), true);
  assert.equal(shouldForceDbCheck("u", "evict_a:one-more"), true);
});

test("re-marking an existing key at capacity still evicts the oldest (current behavior pin)", () => {
  // addBounded checks size >= CAP before Set.add, so re-marking an
  // already-present key while full evicts the oldest entry even though the
  // set would not have grown. Pinned as-is: the evicted session merely falls
  // back to the bounded dbCheckedAt cache window, so the loss is a documented
  // fast-path degradation, not a security hole.
  for (let i = 0; i < CAP; i++) markSessionForceRevoked(`evict_b:${i}`);
  markSessionForceRevoked(`evict_b:${CAP - 1}`); // re-mark the newest entry
  assert.equal(shouldForceDbCheck("u", "evict_b:0"), false); // oldest evicted
  assert.equal(shouldForceDbCheck("u", "evict_b:1"), true);
  assert.equal(shouldForceDbCheck("u", `evict_b:${CAP - 1}`), true);
  // Re-marking also does NOT refresh FIFO position — Set.add on an existing
  // member keeps its original insertion slot. After the eviction above the set
  // holds 1023 entries ordered 1..CAP-1; re-mark evict_b:1, then push two new
  // keys (first refills to capacity, second evicts the oldest). The oldest is
  // still evict_b:1 despite its recent re-mark.
  markSessionForceRevoked("evict_b:1");
  markSessionForceRevoked("evict_b:new-1"); // size back to CAP, no eviction
  markSessionForceRevoked("evict_b:new-2"); // over capacity → evicts evict_b:1
  assert.equal(shouldForceDbCheck("u", "evict_b:1"), false);
  assert.equal(shouldForceDbCheck("u", "evict_b:2"), true);
  assert.equal(shouldForceDbCheck("u", "evict_b:new-1"), true);
  assert.equal(shouldForceDbCheck("u", "evict_b:new-2"), true);
});

test("user ledger is bounded independently; a session flood never evicts user marks", () => {
  markUserForceRevalidate("evict_c:user-sentinel");
  // Saturate the *session* set — the user set must be untouched.
  for (let i = 0; i < CAP + 8; i++) markSessionForceRevoked(`evict_c:s${i}`);
  assert.equal(shouldForceDbCheck("evict_c:user-sentinel", "sess_any"), true);
  // Now saturate the *user* set — the sentinel is the oldest and gets evicted.
  for (let i = 0; i < CAP; i++) markUserForceRevalidate(`evict_c:u${i}`);
  assert.equal(shouldForceDbCheck("evict_c:user-sentinel", "sess_any"), false);
  assert.equal(shouldForceDbCheck("evict_c:u0", "sess_any"), true);
  assert.equal(shouldForceDbCheck(`evict_c:u${CAP - 1}`, "sess_any"), true);
});
