// Who src/proxy.ts lets reach the admin surface. These are coarse, DB-checked
// pre-filters, never the authority: every /api/admin route has its own wrapper
// (withAdmin / withIssueAdmin / withPermission, scripts/audit-routes.mts) and
// every admin page its own DB-checked guard (guardrail 29). A rule here may
// refuse less than the route behind it, never more, or it would deny a caller
// the route admits.
//
// Every rule reads the EFFECTIVE permission mask (effectivePermissions: the ADMIN
// role carries the ADMIN superbit, an unseeded row its role preset) — except the
// /api/settings backstop, which is the role LABEL on purpose (guardrail 6a).
//
// These are RESTRICTIONS, so they fold case: a mis-cased path can only be
// refused more, never admitted more. (The exemptions in proxy-paths.ts match
// exactly, for the same reason the other way round.)
//
// Leaf module — imports only permissions.ts (itself import-free).

import { hasPermission, Permission, type PermissionValue } from "./permissions";

// The admin-area capabilities. The ADMIN superbit passes any check on its own
// (hasPermission), so it needs no entry.
const ADMIN_AREA_PERMISSIONS: PermissionValue[] = [
  Permission.MANAGE_USERS,
  Permission.MANAGE_REQUESTS,
  Permission.MANAGE_ISSUES,
];

// Any admin-area access at all: the gate for the /api/admin/* backstop and the
// /admin subtree (the admin layout asks the same question).
export function hasAdminAreaAccess(perms: bigint): boolean {
  return hasPermission(perms, ADMIN_AREA_PERMISSIONS);
}

// /admin page sections the proxy narrows to one bit. Every other section admits
// any admin-area bit here and leaves the finer rule to its page, which must run
// its own guard: redirecting a delegate before that guard could would deny a
// page the delegate is allowed (e.g. a MANAGE_REQUESTS holder on /admin).
const ADMIN_PAGE_SECTIONS: ReadonlyArray<readonly [prefix: string, required: PermissionValue]> = [
  ["/admin/issues", Permission.MANAGE_ISSUES],
  ["/admin/users", Permission.MANAGE_USERS],
];

// The bits that open an /admin… page (`path` already lowercased). A section
// prefix matches generously (`/admin/issuesx` still needs MANAGE_ISSUES): this
// is a restriction. A path that only starts with the letters (`/adminx`) is no
// admin page at all and needs the ADMIN superbit.
function adminPageRequirement(path: string): PermissionValue[] {
  for (const [prefix, required] of ADMIN_PAGE_SECTIONS) {
    if (path.startsWith(prefix)) return [required];
  }
  if (path === "/admin" || path.startsWith("/admin/")) return ADMIN_AREA_PERMISSIONS;
  return [Permission.ADMIN];
}

export type ProxyAccess = "allow" | "forbidden" | "redirect-home";

// The proxy's admin-surface decision for a signed-in caller: "forbidden" is the
// JSON 403 for an API, "redirect-home" the page bounce to the app root.
export function proxyAccessDecision(pathname: string, role: string, perms: bigint): ProxyAccess {
  const path = pathname.toLowerCase();

  // /api/admin/*: defense-in-depth for a per-route guard that is ever missing.
  // It must admit every MANAGE_* delegate, because the per-route guards do (a
  // plain USER holding MANAGE_ISSUES reaches /api/admin/fix-match/*), so it
  // refuses only callers with no admin-area access of any kind. Permission-based
  // like those guards: no route admits by the ISSUE_ADMIN label alone, so an
  // ISSUE_ADMIN whose management bits were all cleared is refused here too.
  if (path.startsWith("/api/admin/")) {
    return hasAdminAreaAccess(perms) ? "allow" : "forbidden";
  }

  // /api/settings (the bare route and its subtree) is ADMIN-only, exactly:
  // every handler is withAdmin, which is hasRole on the role LABEL (a USER
  // holding the ADMIN bit is refused there too), and scripts/audit-routes.mts
  // refuses any weaker wrapper on this prefix (STRICT_ADMIN_PREFIXES). So this
  // mirrors the routes precisely — it can never deny a caller a settings
  // handler would admit — and is deliberately stricter than the /api/admin/*
  // rule above. Admitting a delegate here means changing the wrapper, this
  // check, the audit list and both tests together, on purpose (guardrail 6a).
  if (path === "/api/settings" || path.startsWith("/api/settings/")) {
    return role === "ADMIN" ? "allow" : "forbidden";
  }

  if (path.startsWith("/admin")) {
    return hasPermission(perms, adminPageRequirement(path)) ? "allow" : "redirect-home";
  }
  return "allow";
}
