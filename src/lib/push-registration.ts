import { createHash } from "node:crypto";
import type { prisma } from "@/lib/prisma";

// The write side shared by /api/push/subscribe (web) and /api/push/apns (iOS):
// the per-user cap, its eviction, and the removal tombstones that keep a removed
// browser from re-registering itself on its next page load.
//
// Every helper here runs inside the caller's interactive transaction, AFTER
// lockUserPushRegistrationsInTx, one statement at a time (guardrail 23c), with
// no try/catch around a write (guardrail 23).

// Typed off the EXTENDED client, like session-footholds.ts: the generated
// TransactionClient doesn't fit the client the encryption extension returns.
type PushRegistrationClient = Pick<typeof prisma, "pushSubscription" | "pushSubscriptionRemoval" | "$executeRaw">;

// Per-user advisory lock, two-key form (4620, hashtext(userId)) — 4610/4611 are
// the MFA and Trakt per-user namespaces. Without it the cap check was a count →
// delete-oldest → insert at READ COMMITTED, so two concurrent registrations both
// saw room and left the user one over the cap for good.
export async function lockUserPushRegistrationsInTx(tx: PushRegistrationClient, userId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(4620, hashtext(${userId}))`;
}

// Newest tombstones kept per user. A tombstone only matters while the removed
// browser still holds its subscription; capping the list bounds what an account
// that churns registrations can make the table hold.
export const MAX_PUSH_REMOVALS_PER_USER = 50;

// Tombstones hold a hash of the endpoint, never the endpoint: a push-service URL
// is a delivery capability for that browser, and a removed one has no reason to
// stay in the database or its backups. Domain-separated, like apnsEndpointFor.
export function pushEndpointHash(endpoint: string): string {
  return createHash("sha256").update(`summonarr-push-removal:v1:${endpoint}`).digest("hex");
}

export async function isPushEndpointRemovedInTx(
  tx: PushRegistrationClient,
  userId: string,
  endpoint: string,
): Promise<boolean> {
  const row = await tx.pushSubscriptionRemoval.findUnique({
    where: { userId_endpointHash: { userId, endpointHash: pushEndpointHash(endpoint) } },
    select: { id: true },
  });
  return row !== null;
}

// A deliberate subscribe from that browser: the user wants it back.
export async function clearPushEndpointRemovalInTx(
  tx: PushRegistrationClient,
  userId: string,
  endpoint: string,
): Promise<void> {
  await tx.pushSubscriptionRemoval.deleteMany({ where: { userId, endpointHash: pushEndpointHash(endpoint) } });
}

// Records removed WEB rows. An iOS row needs none: the app has no page-load
// resync, it re-registers deliberately.
export async function tombstoneRemovedPushRowsInTx(
  tx: PushRegistrationClient,
  userId: string,
  rows: ReadonlyArray<{ endpoint: string; platform: string }>,
): Promise<void> {
  const web = rows.filter((r) => r.platform !== "ios");
  if (web.length === 0) return;
  for (const row of web) {
    const endpointHash = pushEndpointHash(row.endpoint);
    await tx.pushSubscriptionRemoval.upsert({
      where: { userId_endpointHash: { userId, endpointHash } },
      create: { userId, endpointHash },
      update: { removedAt: new Date() },
    });
  }
  const stale = await tx.pushSubscriptionRemoval.findMany({
    where: { userId },
    orderBy: { removedAt: "desc" },
    skip: MAX_PUSH_REMOVALS_PER_USER,
    select: { id: true },
  });
  if (stale.length > 0) {
    await tx.pushSubscriptionRemoval.deleteMany({ where: { id: { in: stale.map((r) => r.id) } } });
  }
}

// The user's registration count, for the cap check.
export async function countUserPushRegistrationsInTx(tx: PushRegistrationClient, userId: string): Promise<number> {
  return tx.pushSubscription.count({ where: { userId } });
}

// Makes room for one more registration under `cap` (0 or less = no cap) by
// evicting the user's oldest row. An evicted web row is tombstoned so that
// browser's next page load can't bring it back and evict another device in turn.
export async function evictOldestForCapInTx(tx: PushRegistrationClient, userId: string, cap: number): Promise<void> {
  if (cap <= 0) return;
  if ((await countUserPushRegistrationsInTx(tx, userId)) < cap) return;
  const oldest = await tx.pushSubscription.findFirst({
    where: { userId },
    orderBy: { createdAt: "asc" },
    select: { id: true, endpoint: true, platform: true },
  });
  if (!oldest) return;
  // deleteMany (not delete): a missing row is count 0, not a P2025 that would
  // abort the transaction (guardrail 23).
  await tx.pushSubscription.deleteMany({ where: { id: oldest.id } });
  await tombstoneRemovedPushRowsInTx(tx, userId, [oldest]);
}
