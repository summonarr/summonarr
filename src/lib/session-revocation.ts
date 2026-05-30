// In-memory single-replica revocation fast path.
//
// The cross-replica source of truth for revocation is the AuthSession row
// (deleted by revokeAllUserSessions / revokeSessionById / signOut) plus the
// sessionsRevokedAt cutoff. verifyAndRefreshSession skips that DB lookup inside
// a short dbCheckedAt cache window (10s admin / 60s user) for the hot path.
//
// These sets close that window on the replica that issued the revoke: a session
// or user marked here forces verifyAndRefreshSession to bypass the cache and hit
// the DB on the very next request, so a "revoke this device" / "log out
// everywhere" action takes effect immediately on the issuing replica instead of
// up to the cache interval later. Other replicas still converge via the DB row
// deletion + sessionsRevokedAt cutoff.
//
// Bounded to cap memory growth on long-lived processes (auth#34). Entries are
// never consumed on read — a cached token may be replayed several times before
// the DB rejects it, so the force-check must persist; FIFO eviction reclaims
// space once the revoked session is long gone.

const FORCE_REVOKE_MAX = 1024;

function addBounded(set: Set<string>, key: string): void {
  if (set.size >= FORCE_REVOKE_MAX) {
    // Evict oldest insertion (Sets retain insertion order in JS).
    const first = set.values().next().value;
    if (first !== undefined) set.delete(first);
  }
  set.add(key);
}

const forceRevalidateUserIds = new Set<string>();
const forceRevokeSessions = new Set<string>();

export function markUserForceRevalidate(userId: string): void {
  addBounded(forceRevalidateUserIds, userId);
}

export function markSessionForceRevoked(sessionId: string): void {
  addBounded(forceRevokeSessions, sessionId);
}

// Consulted by verifyAndRefreshSession before honoring the dbCheckedAt fast path.
export function shouldForceDbCheck(userId: string, sessionId: string): boolean {
  return forceRevokeSessions.has(sessionId) || forceRevalidateUserIds.has(userId);
}
