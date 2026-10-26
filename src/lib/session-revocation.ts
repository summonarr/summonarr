import { processSingleton } from "./process-singleton";

// In-memory single-replica revocation fast path.
//
// The cross-replica source of truth for revocation is the AuthSession row
// (deleted by revokeAllUserSessions / revokeSessionById / signOut) plus the
// sessionsRevokedAt cutoff. verifyAndRefreshSession skips that DB lookup inside
// a short dbCheckedAt cache window (10s for a token with admin-area access —
// the ADMIN bit or any management bit — 60s otherwise) for the hot path.
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

// Process-wide, not module-scoped (process-singleton.ts). Turbopack copies this
// module into every server chunk that imports it: the revoke routes mark in
// their chunk, while the proxy and every page/layout render read their OWN
// copies — which nothing ever wrote. A production build showed exactly that (the
// proxy's and the SSR chunks' copies carried only shouldForceDbCheck over empty
// Sets), so "takes effect on the very next request" held for withAuth API
// routes only, and a revoked session kept rendering pages for up to the
// dbCheckedAt window (10s with admin-area access / 60s otherwise).
const forceRevalidateUserIds = processSingleton("session-revocation:users", () => new Set<string>());
const forceRevokeSessions = processSingleton("session-revocation:sessions", () => new Set<string>());

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

// A restore deletes every AuthSession and stamps sessionsRevokedAt, but a
// browser cookie re-signed in the last 10s (admin) or 60s (everyone else)
// skips that lookup. The per-user mark set holds 1024 ids, so it cannot name
// every account on a large restore. This floor forces every cached check from
// before the restore onto the slow path. Pass 0 only to clear it (tests).
const cachedCheckFloor = processSingleton("session-revocation:floor", () => ({ sec: 0 }));

export function invalidateCachedSessionChecks(atSec = Math.floor(Date.now() / 1000)): void {
  cachedCheckFloor.sec = atSec;
}

export function cachedSessionCheckIsStale(dbCheckedAt: number): boolean {
  return cachedCheckFloor.sec > 0 && dbCheckedAt <= cachedCheckFloor.sec;
}
