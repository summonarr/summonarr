// Overseerr-style capability model.
//
// `permissions` (a BigInt bitmask on User) is the AUTHORITATIVE capability
// check. The Prisma `Role` enum is now a coarse PRESET that seeds the bitmask
// (see PRESETS) plus a label still used for admin-area gating in proxy.ts and
// the withAdmin wrapper. `withIssueAdmin` is bitmask-backed — it gates on the
// MANAGE_ISSUES bit so clearing that bit actually revokes issue access — and
// `hasPermission()` here is the source of truth for everything finer-grained.
//
// Leaf module — ZERO non-builtin imports — so client components (the admin
// permission editor), API routes, and the edge proxy can all import it. Mirrors
// src/lib/settings-sensitive-keys.ts.
//
// Storage: BIGINT in Postgres, `bigint` in JS, a decimal string in the session
// JWT (BigInt is not JSON-serializable — parse/serialize at that boundary). A JS
// `Int` bitmask would silently overflow at bit 31 (bitwise operators coerce to
// signed-32-bit); every bit here is `1n << Nn` and all math is BigInt.

export const Permission = {
  // Superuser — short-circuits every check. Seeded for role=ADMIN.
  ADMIN: 1n << 0n,

  // ─── Management (admin-area) ──────────────────────────────────────────────
  MANAGE_USERS: 1n << 1n,
  MANAGE_REQUESTS: 1n << 2n, // approve/decline others' requests; see all requests
  MANAGE_ISSUES: 1n << 3n, // == legacy ISSUE_ADMIN capability

  // ─── Requesting ───────────────────────────────────────────────────────────
  // REQUEST is the umbrella; REQUEST_MOVIE / REQUEST_TV narrow it (Overseerr
  // semantics — either the umbrella OR the specific bit grants the type).
  REQUEST: 1n << 4n,
  REQUEST_MOVIE: 1n << 5n,
  REQUEST_TV: 1n << 6n,

  // ─── Auto-approve (skip the pending queue) ────────────────────────────────
  AUTO_APPROVE: 1n << 7n,
  AUTO_APPROVE_MOVIE: 1n << 8n,
  AUTO_APPROVE_TV: 1n << 9n,

  // Request on behalf of another user (admin / power user). Used in Phase 2.
  REQUEST_ON_BEHALF: 1n << 10n,

  // Exempt from request quotas (== legacy quotaExempt).
  QUOTA_UNLIMITED: 1n << 11n,

  // ─── 4K block ─────────────────────────────────────────────────────────────
  // Live: 4K requests + auto-approve are wired end-to-end (request-4k-button →
  // /api/requests is4k → addMovieToRadarr/addSeriesToSonarr "4k" variant). Bit
  // numbers are fixed so stored masks never need renumbering.
  REQUEST_4K: 1n << 12n,
  REQUEST_4K_MOVIE: 1n << 13n,
  REQUEST_4K_TV: 1n << 14n,
  AUTO_APPROVE_4K: 1n << 15n,
  AUTO_APPROVE_4K_MOVIE: 1n << 16n,
  AUTO_APPROVE_4K_TV: 1n << 17n,

  // ─── Advanced request options ─────────────────────────────────────────────
  // Choose a Radarr/Sonarr quality profile at request time. Power-user grant;
  // without it a request silently uses the target instance's configured default.
  // ADMIN always passes via the superbit.
  REQUEST_ADVANCED: 1n << 18n,
} as const;

export type PermissionValue = (typeof Permission)[keyof typeof Permission];

// OR of every defined bit. The admin PATCH validator rejects masks that set bits
// outside this so a client can't smuggle undefined bits into the column.
export const KNOWN_MASK: bigint = Object.values(Permission).reduce(
  (mask, bit) => mask | bit,
  0n,
);

// Convenience: any auto-approve bit (incl. 4K). Used by the admin UI to badge a
// user as "auto-approve" from the raw mask, without the ADMIN short-circuit.
export const AUTO_APPROVE_MASK: bigint =
  Permission.AUTO_APPROVE |
  Permission.AUTO_APPROVE_MOVIE |
  Permission.AUTO_APPROVE_TV |
  Permission.AUTO_APPROVE_4K |
  Permission.AUTO_APPROVE_4K_MOVIE |
  Permission.AUTO_APPROVE_4K_TV;

// Role presets. Keys match the Prisma Role enum values; kept as plain strings so
// this leaf module needs no generated-client import.
export const PRESETS: Record<string, bigint> = {
  USER: Permission.REQUEST | Permission.REQUEST_MOVIE | Permission.REQUEST_TV,
  ISSUE_ADMIN:
    Permission.REQUEST |
    Permission.REQUEST_MOVIE |
    Permission.REQUEST_TV |
    Permission.MANAGE_ISSUES,
  ADMIN: Permission.ADMIN,
};

export function defaultPermissionsForRole(role: string): bigint {
  return PRESETS[role] ?? PRESETS.USER;
}

// `permissions === 0n` means the row was never seeded — a legacy row in the
// window between `prisma db push` and the migration, or a create site that
// forgot to seed. Fall back to the role preset so nobody is locked out. A
// deliberately-restricted user has at least one bit set (non-zero), which is
// taken as authoritative. role=ADMIN always resolves to the ADMIN superbit.
//
// Stored values (DB + JWT) stay raw; this is applied only when building the
// authorization view of a session (see claimsToSession / auth()).
export function effectivePermissions(role: string, permissions: bigint): bigint {
  if (role === "ADMIN") return permissions | Permission.ADMIN;
  return permissions === 0n ? defaultPermissionsForRole(role) : permissions;
}

// Core check. The ADMIN superbit grants everything. mode "or" (default): any of
// the required bits satisfies; "and": all required must be set.
export function hasPermission(
  userPerms: bigint,
  required: PermissionValue | PermissionValue[],
  mode: "and" | "or" = "or",
): boolean {
  if ((userPerms & Permission.ADMIN) !== 0n) return true;
  const reqs = Array.isArray(required) ? required : [required];
  if (reqs.length === 0) return true;
  return mode === "and"
    ? reqs.every((r) => (userPerms & r) !== 0n)
    : reqs.some((r) => (userPerms & r) !== 0n);
}

// Can this permission set request the given media type at the given resolution?
// Encodes the umbrella-OR-specific rule once; the 4K bits are AND-ed on top for
// 4K requests. The is4k path gates live 4K requests (see /api/requests).
export function canRequest(
  userPerms: bigint,
  mediaType: "MOVIE" | "TV",
  is4k: boolean,
  serverAll4k = false,
): boolean {
  const base =
    mediaType === "MOVIE"
      ? hasPermission(userPerms, [Permission.REQUEST, Permission.REQUEST_MOVIE])
      : hasPermission(userPerms, [Permission.REQUEST, Permission.REQUEST_TV]);
  if (!base) return false;
  if (!is4k) return true;
  // Server-wide 4K (admin Setting): anyone who can request the base media type can
  // also request it in 4K, without the per-user REQUEST_4K bit. Gating is then
  // "per-user permission OR server-wide toggle" (admins always pass via ADMIN).
  if (serverAll4k) return true;
  return mediaType === "MOVIE"
    ? hasPermission(userPerms, [Permission.REQUEST_4K, Permission.REQUEST_4K_MOVIE])
    : hasPermission(userPerms, [Permission.REQUEST_4K, Permission.REQUEST_4K_TV]);
}

export function canAutoApprove(
  userPerms: bigint,
  mediaType: "MOVIE" | "TV",
  is4k: boolean,
): boolean {
  if (is4k) {
    return mediaType === "MOVIE"
      ? hasPermission(userPerms, [Permission.AUTO_APPROVE_4K, Permission.AUTO_APPROVE_4K_MOVIE])
      : hasPermission(userPerms, [Permission.AUTO_APPROVE_4K, Permission.AUTO_APPROVE_4K_TV]);
  }
  return mediaType === "MOVIE"
    ? hasPermission(userPerms, [Permission.AUTO_APPROVE, Permission.AUTO_APPROVE_MOVIE])
    : hasPermission(userPerms, [Permission.AUTO_APPROVE, Permission.AUTO_APPROVE_TV]);
}

// JWT boundary — permissions ride the token as a decimal string.
export function parsePermissions(claim: string | undefined | null): bigint {
  if (!claim) return 0n;
  try {
    return BigInt(claim);
  } catch {
    return 0n;
  }
}

export function serializePermissions(perms: bigint): string {
  return perms.toString();
}

// Validates a client-supplied decimal permission string for the admin editor.
// Returns the parsed mask, or null if it's not a non-negative integer within the
// known bit space.
export function parseAndValidatePermissions(input: unknown): bigint | null {
  if (typeof input !== "string" || !/^\d+$/.test(input)) return null;
  let value: bigint;
  try {
    value = BigInt(input);
  } catch {
    return null;
  }
  if (value < 0n) return null;
  if ((value & ~KNOWN_MASK) !== 0n) return null; // unknown bits set
  return value;
}
