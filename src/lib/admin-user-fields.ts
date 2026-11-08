// The editable fields of PATCH /api/admin/users/[id], and the delegate SUBSET
// rule that bounds what a non-ADMIN MANAGE_USERS holder may hand out. Pure: the
// route owns the reads, the writes and the audit.
import {
  canAutoApproveInstance,
  canRequestInstance,
  canViewMediaInstance,
  type InstanceAccess,
  type InstanceGrants,
  type MediaInstanceAccess,
  type MediaServerGrants,
} from "@/lib/permissions";
import { exceedsCap } from "@/lib/content-rating";

// Per-user notification switches. The list is the type: adding one here makes
// it editable through PATCH.
export const USER_NOTIF_KEYS = [
  "notifyOnApproved",
  "notifyOnAvailable",
  "notifyOnDeclined",
  "emailOnApproved",
  "emailOnAvailable",
  "emailOnDeclined",
  "pushOnApproved",
  "pushOnAvailable",
  "pushOnDeclined",
  "notifyOnIssue",
  "notifyOnComment",
  "emailOnComment",
  "pushOnComment",
] as const;
export type UserNotifKey = (typeof USER_NOTIF_KEYS)[number];

// One list for the self-escalation gate and the quota branch, so the two read
// the same fields.
export const USER_QUOTA_FIELDS = ["movieQuotaLimit", "movieQuotaDays", "tvQuotaLimit", "tvQuotaDays"] as const;
export type UserQuotaField = (typeof USER_QUOTA_FIELDS)[number];

// Every field PATCH recognises. Each request edits exactly one.
export const USER_PATCH_FIELDS = [
  "mediaServer",
  "maxContentRating",
  "permissions",
  "instanceGrants",
  "mediaServerGrants",
  ...USER_QUOTA_FIELDS,
  ...USER_NOTIF_KEYS,
  "role",
] as const;
export type UserPatchField = (typeof USER_PATCH_FIELDS)[number];

// The recognised fields a body names (JSON has no `undefined`, so a present key
// is a sent one; `null` counts — it is how a field is cleared).
export function presentUserPatchFields(body: object): UserPatchField[] {
  return USER_PATCH_FIELDS.filter((field) => Object.hasOwn(body, field));
}

export function isUserQuotaField(field: string): field is UserQuotaField {
  return (USER_QUOTA_FIELDS as readonly string[]).includes(field);
}

export function isUserNotifKey(field: string): field is UserNotifKey {
  return (USER_NOTIF_KEYS as readonly string[]).includes(field);
}

// The fields that grant privileges to the account they are set on. A delegate
// may not set them on its OWN row (permissions and role carry their own gates).
export function isSelfPrivilegeField(field: UserPatchField): boolean {
  return field === "maxContentRating" || field === "instanceGrants" || field === "mediaServerGrants" || isUserQuotaField(field);
}

// ── Delegate SUBSET rule (non-ADMIN caller) ──────────────────────────────────
// A MANAGE_USERS holder may hand out only what it holds itself. The isSelf gates
// stop a delegate editing its OWN privileges, but a delegate can mint a
// sock-puppet (POST /api/admin/users — it knows the password) or pick an
// accomplice, and the target is then not "self": without these checks it could
// grant that account every non-ADMIN bit (MANAGE_REQUESTS, AUTO_APPROVE,
// QUOTA_UNLIMITED, REQUEST_4K, REQUEST_ON_BEHALF, …), access to a RESTRICTED
// named arr instance, visibility into a RESTRICTED Plex/Jellyfin server, or a
// looser content cap, and sign in as it — the self-grant gate defeated in two
// requests. Each helper answers "does the proposed value exceed the caller's
// own?"; the route answers 403 cannotGrantBeyondOwn when it does. ADMIN callers
// never reach them.

// An unregistered slug is judged as a RESTRICTED instance with no serverAll:
// the grant is dormant today but goes live the moment an admin registers that
// slug as restricted, so a delegate must already hold it. Radarr and Sonarr
// share instanceGrants' flat slug namespace, so a slug registered on both must
// be held on both.
export function instanceGrantsBeyondOwn(
  proposed: InstanceGrants,
  callerPerms: bigint,
  callerGrants: InstanceGrants,
  registry: ReadonlyMap<string, InstanceAccess[]>,
): boolean {
  for (const [slug, g] of Object.entries(proposed)) {
    if (!g.request && !g.autoApprove) continue; // a no-op entry grants nothing
    const configs = registry.get(slug) ?? [{ slug, restricted: true, serverAll: false }];
    for (const cfg of configs) {
      if (g.request && !(canRequestInstance(callerPerms, cfg, callerGrants, "MOVIE") || canRequestInstance(callerPerms, cfg, callerGrants, "TV"))) return true;
      if (g.autoApprove && !(canAutoApproveInstance(callerPerms, cfg, callerGrants, "MOVIE") || canAutoApproveInstance(callerPerms, cfg, callerGrants, "TV"))) return true;
    }
  }
  return false;
}

export function mediaServerGrantsBeyondOwn(
  proposed: MediaServerGrants,
  callerPerms: bigint,
  callerGrants: MediaServerGrants,
  registry: { plex: ReadonlyMap<string, MediaInstanceAccess>; jellyfin: ReadonlyMap<string, MediaInstanceAccess> },
): boolean {
  for (const service of ["plex", "jellyfin"] as const) {
    for (const [slug, g] of Object.entries(proposed[service] ?? {})) {
      if (!g.view) continue;
      const cfg = registry[service].get(slug) ?? { slug, restricted: true };
      if (!canViewMediaInstance(callerPerms, cfg, callerGrants, service)) return true;
    }
  }
  return false;
}

// `null` (no cap) is the loosest value: a capped caller may not clear a cap, and
// may not set one more mature than its own. An uncapped caller may set anything.
export function contentCapBeyondOwn(proposed: string | null, callerCap: string | null): boolean {
  if (callerCap === null) return false;
  if (proposed === null) return true;
  return exceedsCap(proposed, callerCap);
}

// A quota field's stored value. A per-user window of 0 days means the 7-day
// default when the quota is resolved (resolveUserQuota), exactly like no value,
// so it is stored as no value: the row then says what is enforced.
export function storedQuotaValue(field: UserQuotaField, value: number | null): number | null {
  if (value === 0 && (field === "movieQuotaDays" || field === "tvQuotaDays")) return null;
  return value;
}
