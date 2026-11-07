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
//
// A USER mark is bounded in time as well: it forces only tokens whose last DB
// check (dbCheckedAt) is at or before the mark. The mark lands after the DB write
// it guards (guardrail 27), so every token re-signed from a pre-write read is
// still forced, on every presentation; the token the next slow path re-signs
// carries a later dbCheckedAt and takes the fast path again. Without that bound
// a user whose role was edited (and who stays active) paid the full DB check on
// every request for the life of the process.

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
// userId → when it was marked (epoch seconds, the same clock as dbCheckedAt).
// A new key so a hot reload never reads the old Set shape under the old key.
const forceRevalidateUserIds = processSingleton("session-revocation:userMarks", () => new Map<string, number>());
const forceRevokeSessions = processSingleton("session-revocation:sessions", () => new Set<string>());

export function markUserForceRevalidate(userId: string): void {
  const nowSec = Math.floor(Date.now() / 1000);
  if (forceRevalidateUserIds.has(userId)) {
    // A re-mark moves the bound to now and the entry to the newest FIFO slot,
    // so eviction always takes the oldest mark.
    forceRevalidateUserIds.delete(userId);
  } else if (forceRevalidateUserIds.size >= FORCE_REVOKE_MAX) {
    const first = forceRevalidateUserIds.keys().next().value;
    if (first !== undefined) forceRevalidateUserIds.delete(first);
  }
  forceRevalidateUserIds.set(userId, nowSec);
}

export function markSessionForceRevoked(sessionId: string): void {
  addBounded(forceRevokeSessions, sessionId);
}

// Consulted by verifyAndRefreshSession before honoring the dbCheckedAt fast path.
// `dbCheckedAt` is the token's last DB check; a user mark forces it only when
// that check is not later than the mark (`<=`: both are whole seconds, and a
// check in the mark's own second may have read the row before the write).
// Without a dbCheckedAt a user mark always forces.
export function shouldForceDbCheck(userId: string, sessionId: string, dbCheckedAt?: number): boolean {
  if (forceRevokeSessions.has(sessionId)) return true;
  const markedAt = forceRevalidateUserIds.get(userId);
  if (markedAt === undefined) return false;
  return typeof dbCheckedAt !== "number" || dbCheckedAt <= markedAt;
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
