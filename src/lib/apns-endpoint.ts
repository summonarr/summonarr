import { createHash } from "node:crypto";
import { prisma } from "./prisma";
import { isPrismaErrorCode } from "@/lib/prisma-errors";

// PushSubscription.endpoint is the row's UNIQUE key: the push-service URL for a
// web row, a synthetic handle for an iOS (APNs) row. That handle used to be
// `apns:<device token>` — the raw token, in plaintext, in the column right
// beside the AES-GCM-encrypted `deviceToken` (guardrail 7a), which made the
// encryption pointless: a database dump or a backup handed out every device
// token anyway.
//
// The handle is now a SHA-256 of the token, domain-separated. Unkeyed on
// purpose: an APNs token is 32+ opaque random bytes, so its hash can be neither
// reversed nor enumerated, and an unkeyed hash survives a NEXTAUTH_SECRET
// rotation — a keyed one would orphan every row (re-registration would
// duplicate the device, DELETE would miss it). The prefix carries a `:`, which
// a hex token never does, so the two forms can't be confused.
//
// The iOS wire contract is unchanged: the app still POSTs/DELETEs its
// `deviceToken`, and the server derives the handle from it.

export const APNS_ENDPOINT_PREFIX = "apns:sha256:";

export function apnsEndpointFor(deviceToken: string): string {
  return APNS_ENDPOINT_PREFIX + createHash("sha256").update(`summonarr-apns-endpoint:v1:${deviceToken}`).digest("hex");
}

// The pre-2026-10-17 handle. Read only to find and migrate old rows.
export function legacyApnsEndpointFor(deviceToken: string): string {
  return `apns:${deviceToken}`;
}

// Same shape as push-body.ts's DEVICE_TOKEN_RE, lowercased (the route stored it so).
const LEGACY_ENDPOINT_RE = /^apns:((?:[0-9a-f]{2}){32,100})$/;

export function legacyApnsToken(endpoint: string): string | null {
  return LEGACY_ENDPOINT_RE.exec(endpoint)?.[1] ?? null;
}

// Rewrites every legacy `apns:<token>` row to the hashed handle. Run once per
// boot (instrumentation.ts) — idempotent, and a no-op once nothing is left; the
// /api/push/apns route also migrates a legacy row on the device's next
// register, and deletes either form on DELETE, so a failed or skipped run
// costs nothing but time. Which hashed handles already exist is read up front
// (chunked under the bind-parameter limit, guardrail 23c); then each row is its
// own conditional statement (no interactive transaction): a device that already
// has a hashed row (re-registered before this ran) keeps that one and loses the
// legacy duplicate.
const HASHED_LOOKUP_CHUNK = 1_000;

export async function migrateLegacyApnsEndpoints(): Promise<{ migrated: number; removed: number }> {
  const candidates = await prisma.pushSubscription.findMany({
    where: { platform: "ios", endpoint: { startsWith: "apns:" } },
    select: { id: true, endpoint: true },
  });
  const legacy = candidates.flatMap((row) => {
    const token = legacyApnsToken(row.endpoint);
    return token ? [{ row, endpoint: apnsEndpointFor(token) }] : [];
  });
  const taken = new Set<string>();
  for (let i = 0; i < legacy.length; i += HASHED_LOOKUP_CHUNK) {
    const chunk = legacy.slice(i, i + HASHED_LOOKUP_CHUNK).map((l) => l.endpoint);
    const rows = await prisma.pushSubscription.findMany({ where: { endpoint: { in: chunk } }, select: { endpoint: true } });
    for (const r of rows) taken.add(r.endpoint);
  }
  let migrated = 0;
  let removed = 0;
  for (const { row, endpoint } of legacy) {
    if (!taken.has(endpoint)) {
      try {
        const res = await prisma.pushSubscription.updateMany({ where: { id: row.id, endpoint: row.endpoint }, data: { endpoint } });
        migrated += res.count;
        if (res.count > 0) taken.add(endpoint);
        continue;
      } catch (err) {
        // A registration created the hashed row between the read and this
        // write: it wins, the legacy duplicate goes below.
        if (!isPrismaErrorCode(err, "P2002")) throw err;
      }
    }
    const res = await prisma.pushSubscription.deleteMany({ where: { id: row.id, endpoint: row.endpoint } });
    removed += res.count;
  }
  return { migrated, removed };
}
