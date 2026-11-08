// The proxy's admin-surface rules (src/lib/admin-access.ts), decided from the
// role label and the EFFECTIVE permission mask. The rules are coarse
// pre-filters: each must refuse no caller the guard behind it admits, so the
// tests below hold them against those guards (withAdmin's hasRole, the per-page
// bits). The proxy's use of them is pinned in tests/proxy.test.mts.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.TOKEN_ENCRYPTION_KEY ??= "ab".repeat(32); // api-auth.ts → prisma.ts → token-crypto
process.env.NEXTAUTH_SECRET ??= "admin-access-test-secret-0123456789abcdef";

const { hasAdminAreaAccess, proxyAccessDecision } = await import("../src/lib/admin-access.ts");
const { effectivePermissions, Permission } = await import("../src/lib/permissions.ts");
const { hasRole } = await import("../src/lib/api-auth.ts");

type Caller = { who: string; role: string; perms: bigint };

const caller = (who: string, role: string, stored = 0n): Caller => ({
  who,
  role,
  perms: effectivePermissions(role, stored),
});

const CALLERS: Caller[] = [
  caller("ADMIN", "ADMIN"),
  caller("preset ISSUE_ADMIN", "ISSUE_ADMIN"),
  caller("ISSUE_ADMIN with every management bit cleared", "ISSUE_ADMIN", Permission.REQUEST),
  caller("plain USER", "USER"),
  caller("USER + MANAGE_USERS", "USER", Permission.MANAGE_USERS),
  caller("USER + MANAGE_REQUESTS", "USER", Permission.MANAGE_REQUESTS),
  caller("USER + MANAGE_ISSUES", "USER", Permission.MANAGE_ISSUES),
  caller("USER + the ADMIN bit", "USER", Permission.ADMIN),
];

test("/api/admin/*: admits exactly the callers with admin-area access — by bits, never by the ISSUE_ADMIN label", () => {
  for (const c of CALLERS) {
    const expected = hasAdminAreaAccess(c.perms) ? "allow" : "forbidden";
    assert.equal(proxyAccessDecision("/api/admin/users", c.role, c.perms), expected, c.who);
  }
  const cleared = CALLERS[2];
  assert.equal(proxyAccessDecision("/api/admin/fix-match/search", cleared.role, cleared.perms), "forbidden");
  for (const c of CALLERS.filter((x) => x.who !== cleared.who && x.who !== "plain USER")) {
    assert.equal(proxyAccessDecision("/api/admin/users", c.role, c.perms), "allow", `${c.who} reaches its per-route guard`);
  }
});

test("/api/settings: the role label ADMIN exactly, the same answer withAdmin's hasRole gives (guardrail 6a)", () => {
  for (const c of CALLERS) {
    for (const path of ["/api/settings", "/api/settings/plex"]) {
      assert.equal(
        proxyAccessDecision(path, c.role, c.perms) === "allow",
        hasRole(c.role, "ADMIN"),
        `${c.who} on ${path} must get withAdmin's answer`,
      );
    }
  }
  const delegate = CALLERS[5];
  assert.equal(proxyAccessDecision("/api/settingsx", delegate.role, delegate.perms), "allow", "a sibling prefix is not settings");
});

test("/admin pages: issues needs MANAGE_ISSUES, users needs MANAGE_USERS, the rest any admin-area bit", () => {
  const decide = (path: string, c: Caller) => proxyAccessDecision(path, c.role, c.perms);
  const byWho = new Map(CALLERS.map((c) => [c.who, c]));
  const issues = byWho.get("USER + MANAGE_ISSUES")!;
  const users = byWho.get("USER + MANAGE_USERS")!;
  const requests = byWho.get("USER + MANAGE_REQUESTS")!;

  assert.equal(decide("/admin/issues", issues), "allow");
  assert.equal(decide("/admin/users", issues), "redirect-home");
  assert.equal(decide("/admin/users", users), "allow");
  assert.equal(decide("/admin/issues", users), "redirect-home");
  for (const path of ["/admin", "/admin/activity", "/admin/arr-system"]) {
    assert.equal(decide(path, requests), "allow", `${path} is left to the page's own guard`);
    assert.equal(decide(path, byWho.get("plain USER")!), "redirect-home");
  }
  for (const c of [byWho.get("ADMIN")!, byWho.get("USER + the ADMIN bit")!]) {
    for (const path of ["/admin", "/admin/users", "/admin/issues", "/adminx"]) {
      assert.equal(decide(path, c), "allow", `${c.who} on ${path}`);
    }
  }
  // Not an admin page, only its letters: nothing short of the ADMIN bit opens it.
  assert.equal(decide("/adminx", requests), "redirect-home");
});

test("every admin rule folds case: a mis-cased path is refused like its lowercase form", () => {
  const delegate = CALLERS[5];
  const user = CALLERS[3];
  assert.equal(proxyAccessDecision("/API/Settings", delegate.role, delegate.perms), "forbidden");
  assert.equal(proxyAccessDecision("/Api/Admin/users", user.role, user.perms), "forbidden");
  assert.equal(proxyAccessDecision("/ADMIN/Users", delegate.role, delegate.perms), "redirect-home");
});

test("paths outside the admin surface are always allowed through", () => {
  for (const c of CALLERS) {
    for (const path of ["/", "/movies", "/api/requests", "/api/adminx", "/settings"]) {
      assert.equal(proxyAccessDecision(path, c.role, c.perms), "allow", `${c.who} on ${path}`);
    }
  }
});

test("hasAdminAreaAccess: any management bit or the ADMIN superbit", () => {
  assert.equal(hasAdminAreaAccess(0n), false);
  assert.equal(hasAdminAreaAccess(Permission.REQUEST | Permission.AUTO_APPROVE), false);
  for (const bit of [Permission.MANAGE_USERS, Permission.MANAGE_REQUESTS, Permission.MANAGE_ISSUES, Permission.ADMIN]) {
    assert.equal(hasAdminAreaAccess(bit), true);
  }
});
