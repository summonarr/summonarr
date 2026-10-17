// Jellyfin offboarding — sign out the Summonarr account of a member the
// Jellyfin server no longer has (guardrail 6j).
//
// Removing or disabling an account on the Jellyfin server stops it signing in
// here (Jellyfin refuses the credential and the QuickConnect request), but the
// Summonarr session it already holds stays valid: a browser's until its
// configured deadline, the iOS app's forever (guardrail 6c). The hourly Jellyfin
// user sync (download-policy.ts) is the one place that learns of the departure,
// so it hands every identity it just marked inactive to this module, and the
// account whose SIGN-IN identity it is — User.jellyfinUserId, which only the
// Jellyfin and QuickConnect sign-ins write — is signed out everywhere through
// revokeAllUserSessions, with an audit row.
//
// Rules:
//   - Only when the identity is gone from EVERY configured Jellyfin server
//     (guardrail 35 — the membership union fails open). "Still a member" is any
//     ACTIVE jellyfin MediaServerUser row that carries the id OR is linked to
//     the account, on any server.
//   - A server with no opinion poisons the run. A configured server whose user
//     fetch failed or came back empty THIS run, and that has never stored a user
//     (cold), could be the one the member is still on — nothing is revoked and
//     every identity waits for the next run. A server with rows is STALE, not
//     indeterminate: its last-known rows count, so one outage doesn't stall the
//     others.
//   - ADMINs (role or the ADMIN bit) are exempt, as the Plex membership
//     re-check in session-refresh.ts exempts them — never lock the operator out
//     over a media-server change. Re-decided on a fresh read under advisory lock
//     42 (the role-change lock) inside the revoke's own transaction.
//   - Never a hard delete (guardrail 28). The sessions go; the account and every
//     MediaServerUser row stay.
//   - An identity leaves the pending ledger only once DECIDED (revoked, exempt,
//     still a member, or no account), and only after the revoke committed
//     (guardrail 27), so a failed revoke or a poisoned run retries next hour.
//     The ledger is process-wide (guardrail 27a) and in memory, like the
//     reconcile confirmation counter in download-policy.ts: a restart forgets it.

import { prisma } from "./prisma";
import { revokeAllUserSessions } from "./auth";
import { logAudit } from "./audit";
import { Permission } from "./permissions";
import { processSingleton } from "./process-singleton";
import type { MediaInstanceKey } from "./media-instances";

export const OFFBOARD_PENDING_KEY = "jellyfin-offboarding:pending";
const pendingIds = () => processSingleton(OFFBOARD_PENDING_KEY, () => new Set<string>());

class OffboardExemptError extends Error {}

function isAdminRow(row: { role: string; permissions: bigint | null }): boolean {
  return row.role === "ADMIN" || (typeof row.permissions === "bigint" && (row.permissions & Permission.ADMIN) !== 0n);
}

export type OffboardOutcome = "revoked" | "admin" | "still-member" | "no-account";

export interface OffboardRunResult {
  revoked: number;
  errors: number;
  /** true ⇒ a cold server with no opinion held every identity back. */
  deferred: boolean;
}

export async function offboardJellyfinIdentities(input: {
  /** Jellyfin user ids this run turned inactive (removed or disabled). */
  departed: string[];
  /** Configured servers whose user fetch failed or came back empty this run. */
  noOpinion: MediaInstanceKey[];
}): Promise<OffboardRunResult> {
  const pending = pendingIds();
  for (const id of input.departed) pending.add(id);
  const result: OffboardRunResult = { revoked: 0, errors: 0, deferred: false };
  if (pending.size === 0) return result;

  for (const slug of input.noOpinion) {
    const known = await prisma.mediaServerUser.findFirst({
      where: { source: "jellyfin", serverInstance: slug },
      select: { id: true },
    });
    if (!known) {
      result.deferred = true;
      return result;
    }
  }

  for (const jellyfinUserId of [...pending]) {
    try {
      const outcome = await offboardOne(jellyfinUserId);
      pending.delete(jellyfinUserId);
      if (outcome === "revoked") result.revoked++;
    } catch (err) {
      result.errors++;
      console.warn(
        "[jellyfin-offboarding] session revoke failed; will retry next run:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return result;
}

async function offboardOne(jellyfinUserId: string): Promise<OffboardOutcome> {
  const user = await prisma.user.findUnique({
    where: { jellyfinUserId },
    select: { id: true, name: true, email: true },
  });
  if (!user) return "no-account";

  const stillMember = await prisma.mediaServerUser.findFirst({
    where: {
      source: "jellyfin",
      active: true,
      OR: [{ sourceUserId: jellyfinUserId }, { userId: user.id }],
    },
    select: { id: true },
  });
  if (stillMember) return "still-member";

  // ADMINs are exempt — decided on a fresh read under lock 42, inside the
  // revoke, so a promotion landing after the reads above still counts.
  try {
    await revokeAllUserSessions(user.id, async (tx) => {
      await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(42)");
      const fresh = await tx.user.findUnique({
        where: { id: user.id },
        select: { role: true, permissions: true },
      });
      if (!fresh || isAdminRow(fresh)) throw new OffboardExemptError();
    });
  } catch (err) {
    if (err instanceof OffboardExemptError) return "admin";
    throw err;
  }

  // The revoke committed — a failed audit write must not undo or retry it
  // (guardrail 26).
  void logAudit({
    userId: "system",
    userName: "cron",
    action: "SESSION_REVOKE",
    target: `user:${user.id}`,
    details: {
      targetUser: user.name ?? user.email,
      revokedAll: true,
      reason: "jellyfin_offboarded",
      jellyfinUserId,
    },
  });
  return "revoked";
}
