// Unit tests for badge visibility (src/lib/badge-visibility.ts) — decides
// which media-server badges (Plex / Jellyfin) a user sees. The contract:
// admins (ADMIN superbit) and issue managers (MANAGE_ISSUES bit) see BOTH
// badges so they have full context on any item; a regular user sees only the
// badge for the server they authenticated with; a disabled integration hides
// its badge for everyone; and no session means no badges (fail-closed).
// The decision reads ONLY the permissions bitmask — the role string is
// deliberately ignored (effectivePermissions is applied upstream in
// claimsToSession), which is pinned below.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SummonarrSession } from "../src/lib/api-auth.ts";
import { Permission, PRESETS } from "../src/lib/permissions.ts";
import { getBadgeVisibility } from "../src/lib/badge-visibility.ts";

function makeSession(
  permissions: bigint,
  mediaServer: string | null | undefined,
  role = "USER",
): SummonarrSession {
  return {
    user: { id: "u_1", role, permissions, mediaServer },
    sessionId: "sess_1",
  };
}

// ─── No session → fail closed ────────────────────────────────────────────────

test("null session shows neither badge, even with integrations enabled", () => {
  assert.deepEqual(getBadgeVisibility(null), { showPlex: false, showJellyfin: false });
  assert.deepEqual(getBadgeVisibility(null, { plex: true, jellyfin: true }), {
    showPlex: false,
    showJellyfin: false,
  });
});

// ─── Regular user: badge follows the authenticated server ────────────────────

test("regular Plex user sees only the Plex badge", () => {
  const session = makeSession(PRESETS.USER, "plex");
  assert.deepEqual(getBadgeVisibility(session), { showPlex: true, showJellyfin: false });
});

test("regular Jellyfin user sees only the Jellyfin badge", () => {
  const session = makeSession(PRESETS.USER, "jellyfin");
  assert.deepEqual(getBadgeVisibility(session), { showPlex: false, showJellyfin: true });
});

test("regular user with no mediaServer (null/undefined) sees neither badge", () => {
  assert.deepEqual(getBadgeVisibility(makeSession(PRESETS.USER, null)), {
    showPlex: false,
    showJellyfin: false,
  });
  assert.deepEqual(getBadgeVisibility(makeSession(PRESETS.USER, undefined)), {
    showPlex: false,
    showJellyfin: false,
  });
});

test("mediaServer match is exact — casing and unknown servers do not count", () => {
  assert.deepEqual(getBadgeVisibility(makeSession(PRESETS.USER, "Plex")), {
    showPlex: false,
    showJellyfin: false,
  });
  assert.deepEqual(getBadgeVisibility(makeSession(PRESETS.USER, "emby")), {
    showPlex: false,
    showJellyfin: false,
  });
});

// ─── Privileged bits: ADMIN or MANAGE_ISSUES see both badges ──────────────────

test("ADMIN superbit shows both badges regardless of own mediaServer", () => {
  for (const mediaServer of ["plex", "jellyfin", null]) {
    assert.deepEqual(getBadgeVisibility(makeSession(Permission.ADMIN, mediaServer)), {
      showPlex: true,
      showJellyfin: true,
    });
  }
});

test("MANAGE_ISSUES bit alone shows both badges (issue managers need full context)", () => {
  const session = makeSession(Permission.MANAGE_ISSUES, "plex");
  assert.deepEqual(getBadgeVisibility(session), { showPlex: true, showJellyfin: true });
});

test("ISSUE_ADMIN preset (REQUEST bits + MANAGE_ISSUES) shows both badges", () => {
  const session = makeSession(PRESETS.ISSUE_ADMIN, "jellyfin");
  assert.deepEqual(getBadgeVisibility(session), { showPlex: true, showJellyfin: true });
});

test("other management bits do NOT unlock both badges", () => {
  // MANAGE_USERS / MANAGE_REQUESTS are admin-area powers but not issue triage —
  // those users still only see their own server's badge.
  const perms =
    Permission.MANAGE_USERS | Permission.MANAGE_REQUESTS | Permission.REQUEST;
  assert.deepEqual(getBadgeVisibility(makeSession(perms, "plex")), {
    showPlex: true,
    showJellyfin: false,
  });
});

test("zero permissions fall through to the per-server path", () => {
  // getBadgeVisibility never applies role presets itself — a raw 0n mask (which
  // claimsToSession would have expanded upstream) just means "not privileged".
  assert.deepEqual(getBadgeVisibility(makeSession(0n, "jellyfin")), {
    showPlex: false,
    showJellyfin: true,
  });
});

test("role string is ignored — only the permissions bitmask decides", () => {
  // Pins the boundary contract: effectivePermissions(role, mask) is applied in
  // claimsToSession BEFORE the session reaches this module. A session claiming
  // role=ADMIN with an empty mask is treated as a regular user here.
  assert.deepEqual(getBadgeVisibility(makeSession(0n, "plex", "ADMIN")), {
    showPlex: true,
    showJellyfin: false,
  });
});

// ─── Integration toggles gate everyone, including admins ─────────────────────

test("omitted integrations default to enabled (both true for admins)", () => {
  assert.deepEqual(getBadgeVisibility(makeSession(Permission.ADMIN, null)), {
    showPlex: true,
    showJellyfin: true,
  });
  assert.deepEqual(getBadgeVisibility(makeSession(Permission.ADMIN, null), {}), {
    showPlex: true,
    showJellyfin: true,
  });
});

test("a partially-specified integrations object defaults the missing side to enabled", () => {
  assert.deepEqual(getBadgeVisibility(makeSession(Permission.ADMIN, null), { plex: false }), {
    showPlex: false,
    showJellyfin: true,
  });
  assert.deepEqual(getBadgeVisibility(makeSession(Permission.ADMIN, null), { jellyfin: false }), {
    showPlex: true,
    showJellyfin: false,
  });
});

test("disabled integration hides its badge even for admins", () => {
  assert.deepEqual(
    getBadgeVisibility(makeSession(Permission.ADMIN, "plex"), { plex: false, jellyfin: false }),
    { showPlex: false, showJellyfin: false },
  );
});

test("disabled integration hides the badge for a matching regular user", () => {
  assert.deepEqual(
    getBadgeVisibility(makeSession(PRESETS.USER, "plex"), { plex: false, jellyfin: true }),
    { showPlex: false, showJellyfin: false },
  );
  assert.deepEqual(
    getBadgeVisibility(makeSession(PRESETS.USER, "jellyfin"), { plex: true, jellyfin: false }),
    { showPlex: false, showJellyfin: false },
  );
});

test("enabling only the other server's integration never leaks a badge to a regular user", () => {
  // Jellyfin user with only Plex integration enabled: no badge at all.
  assert.deepEqual(
    getBadgeVisibility(makeSession(PRESETS.USER, "jellyfin"), { plex: true, jellyfin: false }),
    { showPlex: false, showJellyfin: false },
  );
});
