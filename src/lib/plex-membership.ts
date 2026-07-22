import { prisma } from "@/lib/prisma";
import { getPlexFriendEmails } from "@/lib/plex";
import { normalizeEmail } from "@/lib/email-normalize";

// Per-replica cache of the Plex server's shared-user allowlist, used to lock out
// users who have been un-shared from the server without waiting for their
// session to expire or their Plex token to be revoked.
//
// The allowlist is GLOBAL — getPlexFriendEmails returns every shared user's
// email in one call — so a single plex.tv fetch per replica per TTL window
// covers the membership check for every logged-in Plex user. The per-request
// cost in verifyAndRefreshSession is just a Set.has().
//
// Fail-open by design: if Plex is unconfigured, the fetch fails, or it returns
// an empty set, getCachedPlexAllowlist() returns null ("no opinion") and the
// caller does NOT lock anyone out. A plex.tv outage must never log out the
// whole user base. When a prior good set exists it is served stale during an
// outage (continues enforcing the last-known membership) instead of falling
// back to "no opinion".

const ALLOWLIST_TTL_MS = 30 * 60 * 1000; // re-fetch at most every 30 minutes
const RETRY_BACKOFF_MS = 5 * 60 * 1000; // after a failed/empty fetch, wait before retrying

let cache: { emails: Set<string>; fetchedAt: number } | null = null;
let lastAttemptAt = 0;
let inflight: Promise<{ emails: Set<string>; fetchedAt: number } | null> | null = null;

async function fetchAllowlist(): Promise<{ emails: Set<string>; fetchedAt: number } | null> {
  const [adminTokenRow, adminEmailRow, serverUrlRow] = await Promise.all([
    prisma.setting.findUnique({ where: { key: "plexAdminToken" } }),
    prisma.setting.findUnique({ where: { key: "plexAdminEmail" } }),
    prisma.setting.findUnique({ where: { key: "plexServerUrl" } }),
  ]);
  const adminToken = adminTokenRow?.value?.trim();
  const serverUrl = serverUrlRow?.value?.trim();
  // Unconfigured — cannot verify membership. Fail-open.
  if (!adminToken || !serverUrl) return null;

  // getPlexFriendEmails throws on a non-2xx plex.tv response and returns an
  // empty set when it can't resolve the server's machineId. An empty set would
  // lock out EVERY Plex user, so treat empty as "couldn't determine" and
  // fail-open. (The admin email is added only after this guard so an admin-only
  // server isn't mistaken for a successful-but-empty fetch.)
  const emails = await getPlexFriendEmails(adminToken, serverUrl);
  if (emails.size === 0) return null;
  // normalizeEmail matches the sign-in gate in auth.ts (authorizeWithPlex) so
  // both membership checks share one normalization of the admin-email Setting.
  if (adminEmailRow?.value) emails.add(normalizeEmail(adminEmailRow.value));
  return { emails, fetchedAt: Date.now() };
}

/**
 * Returns the set of emails currently shared on the Plex server, or null when
 * membership cannot be determined (unconfigured / fetch failed / empty). A null
 * return means callers MUST fail open — do not lock anyone out.
 *
 * Caches per-replica for ALLOWLIST_TTL_MS. On a cold cache the first caller
 * blocks on the plex.tv fetch so enforcement starts immediately; once a set is
 * cached, an expired entry is served stale while a single background refresh
 * runs, so the hot path never blocks on plex.tv again.
 */
export async function getCachedPlexAllowlist(): Promise<Set<string> | null> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < ALLOWLIST_TTL_MS) return cache.emails;

  // De-dupe concurrent refreshes within a replica and back off after a failure
  // so a persistent plex.tv outage doesn't trigger a fetch on every request.
  if (!inflight && now - lastAttemptAt >= RETRY_BACKOFF_MS) {
    lastAttemptAt = now;
    inflight = fetchAllowlist()
      .then((fresh) => {
        if (fresh) cache = fresh;
        return fresh;
      })
      .catch(() => null)
      .finally(() => {
        inflight = null;
      });
  }

  // Block only on a cold cache, so enforcement begins on the first Plex request
  // after boot. With a stale set in hand, serve it and let the refresh finish in
  // the background.
  if (!cache && inflight) await inflight;

  return cache ? cache.emails : null;
}
