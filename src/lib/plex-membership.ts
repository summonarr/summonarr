import { prisma } from "@/lib/prisma";
import { getPlexFriendEmails } from "@/lib/plex";
import { normalizeEmail } from "@/lib/email-normalize";
import { getMediaInstances, type MediaInstanceConfig } from "@/lib/media-instance-registry";
import { getPlexConfig } from "@/lib/plex-config";
import { plexSettingKey, mediaInstanceLabel, type MediaInstanceKey } from "@/lib/media-instances";

// Per-replica cache of the Plex servers' shared-user allowlist, used to lock out
// users who have been un-shared from every server without waiting for their
// session to expire or their Plex token to be revoked.
//
// Multi-server: every registered Plex instance (getMediaInstances) contributes
// its own machineIdentifier-scoped friend set, cached independently per slug
// with the same TTL / retry-backoff / serve-stale / in-flight-coalescing
// mechanics the single-server version had. The returned Set is the UNION across
// instances — a plex.tv fetch per instance per replica per TTL window covers the
// membership check for every logged-in Plex user, and a session survives as long
// as ANY server still shares with the user (we don't know which server a session
// was signed in against — an accepted trade-off of the union).
//
// Fail-open by design: if no instance is configured, the fetch fails, or it
// returns an empty set, getCachedPlexAllowlist() returns null ("no opinion") and
// the caller does NOT lock anyone out. A plex.tv outage must never log out the
// whole user base. When a prior good set exists for an instance it is served
// stale during an outage (continues enforcing the last-known membership)
// instead of falling back to "no opinion".
//
// THE partial-failure rule: a configured instance that is INDETERMINATE — cold
// (no prior good set) with its fetch failing or empty — poisons the WHOLE call
// to null. Returning a partial union would let session-refresh mass-revoke
// every user whose only membership is on the down server, the exact failure
// this module exists to prevent. An instance with a STALE set is NOT
// indeterminate (it serves stale into the union, so one server's outage never
// blanks the others), and an UNCONFIGURED instance (missing/blank url or token)
// contributes nothing without poisoning — the old single-server "unconfigured →
// null" survives as "zero configured instances → null".
//
// Shape constraint: every DB read in this module's path must be a
// setting.findUnique — getMediaInstances (one findUnique), getPlexConfig (two),
// and the per-instance AdminEmail read below. Do NOT switch to
// getSyncableMediaInstances/isMediaInstanceConfigured (they issue findMany):
// the session-refresh test harness stubs only findUnique, and the Phase-2
// play-history poller shares the same constraint.

const ALLOWLIST_TTL_MS = 30 * 60 * 1000; // re-fetch at most every 30 minutes (per instance)
const RETRY_BACKOFF_MS = 5 * 60 * 1000; // after a failed/empty fetch, wait before retrying (per instance)

type CacheEntry = { emails: Set<string>; fetchedAt: number };

// "ok" — a non-empty scoped set was cached. "unconfigured" — no url/token for
// the slug; contributes nothing, never poisons. "indeterminate" — configured
// but the fetch failed or came back empty; a COLD slug in this state poisons
// the whole call.
type AttemptOutcome = "ok" | "unconfigured" | "indeterminate";

type SlugState = {
  cache: CacheEntry | null;
  lastAttemptAt: number;
  inflight: Promise<AttemptOutcome> | null;
  // Outcome of the most recent settled attempt — what distinguishes a cold
  // unconfigured slug (skip) from a cold failing one (poison) when the cache is
  // empty. An "indeterminate" verdict can be consulted for up to
  // RETRY_BACKOFF_MS (settings aren't re-read inside the window); an
  // "unconfigured" verdict is never older than the current call — the refresh
  // resets lastAttemptAt on that outcome, so every call re-derives it.
  lastOutcome: AttemptOutcome | null;
};

const slugStates = new Map<MediaInstanceKey, SlugState>();

// Memoized composition of the last returned union, keyed on the contributing
// (slug, fetchedAt) pairs — so repeat calls inside a stable window hand back
// the SAME Set instance (the pre-multi-server zero-allocation hot path).
let composed: { key: string; emails: Set<string> } | null = null;

async function fetchSlugAllowlist(slug: MediaInstanceKey): Promise<{ outcome: AttemptOutcome; entry?: CacheEntry }> {
  const [{ url, token }, adminEmailRow] = await Promise.all([
    getPlexConfig(slug),
    prisma.setting.findUnique({ where: { key: plexSettingKey(slug, "AdminEmail") } }),
  ]);
  const adminToken = token?.trim();
  const serverUrl = url?.trim();
  // Unconfigured — this instance cannot be verified and doesn't need to be.
  if (!adminToken || !serverUrl) return { outcome: "unconfigured" };

  // getPlexFriendEmails throws on a non-2xx plex.tv response and returns an
  // empty set when it can't resolve the server's machineId. An empty set would
  // lock out EVERY user of this instance, so treat empty as "couldn't
  // determine". (The admin email is added only after this guard so an
  // admin-only server isn't mistaken for a successful-but-empty fetch.)
  const emails = await getPlexFriendEmails(adminToken, serverUrl);
  if (emails.size === 0) return { outcome: "indeterminate" };
  // normalizeEmail matches the sign-in gate in auth.ts (authorizeWithPlex) so
  // both membership checks share one normalization of the admin-email Setting.
  if (adminEmailRow?.value) emails.add(normalizeEmail(adminEmailRow.value));
  return { outcome: "ok", entry: { emails, fetchedAt: Date.now() } };
}

// De-dupe concurrent refreshes of one slug within a replica and back off after
// a failure so a persistent outage doesn't trigger a fetch on every request.
function startSlugRefresh(slug: MediaInstanceKey, state: SlugState, now: number): void {
  state.lastAttemptAt = now;
  state.inflight = fetchSlugAllowlist(slug)
    .then((res) => {
      if (res.entry) state.cache = res.entry; // failed/empty leaves the prior set — serve-stale
      state.lastOutcome = res.outcome;
      // An "unconfigured" verdict must NOT arm the backoff: the attempt cost
      // three findUniques and zero plex.tv traffic (the backoff exists to
      // protect plex.tv), and honoring a cached "unconfigured" skip after the
      // admin finishes configuring the instance would return an ENFORCING
      // partial union missing that server's members — mass-revoking them for
      // the rest of the window, the exact failure this module forbids. With
      // the reset, the next call re-reads the slug's config immediately: still
      // unconfigured → skip again (cheap); newly configured → a real fetch
      // that either completes the union or cold-poisons to null (fail open).
      if (res.outcome === "unconfigured") state.lastAttemptAt = 0;
      return res.outcome;
    })
    .catch((err) => {
      state.lastOutcome = "indeterminate";
      console.warn(
        `[plex-membership] allowlist fetch failed for ${mediaInstanceLabel("plex", slug)}:`,
        err instanceof Error ? err.message : String(err),
      );
      return "indeterminate" as const;
    })
    .finally(() => {
      state.inflight = null;
    });
}

/**
 * Returns the union of the emails currently shared on every configured Plex
 * instance, or null when membership cannot be determined — nothing configured,
 * the registry unreadable, or ANY configured instance cold with a failing/empty
 * fetch — a partial union would mass-revoke that server's users. A null return
 * means callers MUST fail open — do not lock anyone out.
 *
 * Each instance caches per-replica for ALLOWLIST_TTL_MS. On a cold instance the
 * first caller blocks on its plex.tv fetch so enforcement starts immediately;
 * once a set is cached, an expired entry is served stale into the union while a
 * single background refresh runs, so the hot path never blocks on plex.tv again.
 */
export async function getCachedPlexAllowlist(): Promise<Set<string> | null> {
  const now = Date.now();

  // Which instances exist is re-read per call (one findUnique) — an instance
  // added or removed in the admin settings takes effect on the next check
  // rather than after a TTL. A registry read failure is the same class as a
  // swallowed fetch error: no opinion.
  let instances: MediaInstanceConfig[];
  try {
    instances = await getMediaInstances("plex");
  } catch (err) {
    console.warn(
      "[plex-membership] instance registry read failed; membership check skipped:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }

  // Kick off every due refresh before awaiting any of them, so multiple
  // stale/cold instances fetch concurrently. The gate-check-and-start is
  // synchronous per slug, which is what keeps concurrent callers coalesced
  // onto one in-flight fetch.
  const consulted: Array<{ slug: MediaInstanceKey; state: SlugState }> = [];
  for (const { slug } of instances) {
    let state = slugStates.get(slug);
    if (!state) {
      state = { cache: null, lastAttemptAt: 0, inflight: null, lastOutcome: null };
      slugStates.set(slug, state);
    }
    const fresh = state.cache !== null && now - state.cache.fetchedAt < ALLOWLIST_TTL_MS;
    if (!fresh && !state.inflight && now - state.lastAttemptAt >= RETRY_BACKOFF_MS) {
      startSlugRefresh(slug, state, now);
    }
    consulted.push({ slug, state });
  }

  // Evict state for slugs that left the registry — the same idiom
  // reconcileManagerMap uses for its per-slug manager map (plex-events.ts).
  // Without it a remove-then-re-add of the SAME slug pointing at a DIFFERENT
  // server keeps serving the old server's cached member set (and its
  // machineId-scoped emails) until the 30-min TTL expires, enforcing the wrong
  // allowlist for the new server. A pruned slug's in-flight fetch self-catches,
  // so dropping the state can't leak an unhandled rejection.
  const registered = new Set(instances.map((i) => i.slug));
  for (const slug of slugStates.keys()) {
    if (!registered.has(slug)) slugStates.delete(slug);
  }

  const parts: Array<{ slug: MediaInstanceKey; emails: Set<string>; fetchedAt: number }> = [];
  for (const { slug, state } of consulted) {
    // Block only on a COLD instance, so enforcement begins on the first Plex
    // request after boot. With a stale set in hand, serve it and let the
    // refresh finish in the background.
    if (!state.cache && state.inflight) await state.inflight;

    if (state.cache) {
      // Fresh or stale — either way this instance's last-known membership
      // keeps being enforced. (This also covers a previously-good instance
      // whose settings were later blanked: same retain-the-prior-set rule the
      // single-server version had. Removing the instance from the registry is
      // what stops it contributing.)
      parts.push({ slug, emails: state.cache.emails, fetchedAt: state.cache.fetchedAt });
      continue;
    }
    if (state.lastOutcome === "unconfigured") continue;
    // Cold and indeterminate (failed/empty attempt — possibly a recent one
    // still inside its backoff window): this instance's members are unknown,
    // so the whole call is "no opinion". Its inflight (if any) self-catches,
    // so bailing here never leaks an unhandled rejection.
    return null;
  }

  if (parts.length === 0) return null; // zero configured instances
  // Slugs are lowercase-alnum (registry-validated), so ":"/"|" are unambiguous.
  const key = parts.map((p) => `${p.slug}:${p.fetchedAt}`).join("|");
  if (composed && composed.key === key) return composed.emails;
  const emails =
    parts.length === 1
      ? parts[0].emails // single instance: hand back the cached Set itself, as before
      : new Set(parts.flatMap((p) => [...p.emails]));
  composed = { key, emails };
  return emails;
}
