import { prisma } from "@/lib/prisma";
import { revokeOtherUserSessionsInTx } from "@/lib/auth";
import { clearSessionFootholdsInTx } from "@/lib/session-footholds";
import { markSessionForceRevoked, markUserForceRevalidate } from "@/lib/session-revocation";

// The write behind POST /api/sessions/revoke-all ("sign out everywhere", the
// owner's compromise response — guardrail 6g). Two modes:
//
//   keepSessionId given: every OTHER session row is deleted and the caller stays
//     signed in. sessionsRevokedAt moves up to just before the caller's own
//     session was created, so a cached JWT of a deleted session is refused on
//     every replica at its next DB check while the caller's (iat after its
//     createdAt) still passes.
//   keepSessionId null: every row goes and sessionsRevokedAt is "now", which
//     refuses every JWT minted before it — the caller's included.
//
// Either way the footholds a signed-out device could have planted and the
// calendar feed URL (a bearer credential like a session) go in the same
// transaction. The row deletes go through revokeOtherUserSessionsInTx, the
// helper the 2FA routes use, so the two can't drift on which rows a revoke
// takes. Statements run one at a time (guardrail 23c); the in-memory marks
// follow the commit (guardrail 27). Returns how many sessions were revoked.
export async function signOutEverywhere(userId: string, keepSessionId: string | null | undefined, includeCurrent: boolean): Promise<number> {
  const revoked = await prisma.$transaction(async (tx) => {
    if (includeCurrent) {
      await tx.user.update({
        where: { id: userId },
        data: { sessionsRevokedAt: new Date(), calendarTokenHash: null, calendarTokenCreatedAt: null },
      });
      const ids = await revokeOtherUserSessionsInTx(tx, userId, undefined);
      await clearSessionFootholdsInTx(tx, userId);
      return ids;
    }
    const keep = keepSessionId ?? undefined;
    const callerRow = keep
      ? await tx.authSession.findUnique({ where: { sessionId: keep }, select: { createdAt: true } })
      : null;
    const userRow = await tx.user.findUnique({ where: { id: userId }, select: { sessionsRevokedAt: true } });
    const ids = await revokeOtherUserSessionsInTx(tx, userId, keep);
    await clearSessionFootholdsInTx(tx, userId);
    await tx.user.update({
      where: { id: userId },
      data: { calendarTokenHash: null, calendarTokenCreatedAt: null },
    });
    const cutoff = othersRevokedCutoff(callerRow?.createdAt ?? null, userRow?.sessionsRevokedAt ?? null);
    if (cutoff) await tx.user.update({ where: { id: userId }, data: { sessionsRevokedAt: cutoff } });
    return ids;
  });

  for (const sessionId of revoked) markSessionForceRevoked(sessionId);
  // Close the dbCheckedAt fast-path window on THIS replica at once: a session
  // validated within the last cache interval would otherwise keep riding the
  // cached state. The surviving caller row still passes its DB check.
  markUserForceRevalidate(userId);
  return revoked.length;
}

/**
 * The sessionsRevokedAt a "sign out other devices" stamps: one second before
 * the caller's own session was created, or null to leave it alone — when the
 * caller's row is unknown, or when that would LOWER an existing cutoff (a prior
 * full revoke may have set a later one, and lowering it would let an older JWT
 * still in flight through again).
 */
export function othersRevokedCutoff(callerCreatedAt: Date | null, existing: Date | null): Date | null {
  if (!callerCreatedAt) return null;
  const cutoff = new Date(callerCreatedAt.getTime() - 1000);
  return !existing || cutoff > existing ? cutoff : null;
}
