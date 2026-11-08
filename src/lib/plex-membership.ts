import { prisma } from "@/lib/prisma";
import { getPlexFriendEmails, getPlexMachineId, PLEX_IDENTITY_TIMEOUT_MS, type PlexServerMembers } from "@/lib/plex";
import { normalizeEmail } from "@/lib/email-normalize";
import { getMediaInstances, type MediaInstanceConfig } from "@/lib/media-instance-registry";
import { getPlexConfig } from "@/lib/plex-config";
import { plexSettingKey, mediaInstanceLabel, type MediaInstanceKey } from "@/lib/media-instances";
import { processSingleton } from "@/lib/process-singleton";

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
// instead of falling back to "no opinion". The one way an instance's set
// shrinks to its admin alone: two refreshes in a row in which the server
// identifies itself and plex.tv answers with nobody shared on it (the admin
// unshared the last friend). One such answer is served stale.
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
// Per-instance read: getCachedPlexMembersByInstance hands back each
// instance's OWN set from the same caches (same refresh, backoff and
// serve-stale rules, no extra plex.tv traffic), for the per-server question
// "is this person still shared on THIS server" (Admin → Activity → Users),
// which the union answers wrongly on a multi-server install. Display only —
// enforcement stays on the union and its poison rule.
//
// Shape constraint: every DB read in this module's path must be a
// setting.findUnique — getMediaInstances (one findUnique), getPlexConfig (two),
// and the per-instance AdminEmail read below. Do NOT switch to
// getSyncableMediaInstances/isMediaInstanceConfigured (they issue findMany):
// the session-refresh test harness stubs only findUnique, and the
// play-history poller shares the same constraint (guardrail 35).

const ALLOWLIST_TTL_MS = 30 * 60 * 1000; // re-fetch at most every 30 minutes (per instance)
const RETRY_BACKOFF_MS = 5 * 60 * 1000; // after a failed/empty fetch, wait before retrying (per instance)

// Both member key spaces are cached: plex.tv account ids (immutable — matched
// first) and emails (mutable — the legacy fallback key).
type CacheEntry = { ids: Set<string>; emails: Set<string>; fetchedAt: number };

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
  // Bumped by expirePlexMembershipCache: a fetch started under an older
  // generation (with the old admin token) settles without touching the cache.
  generation: number;
  // Consecutive CONFIRMED-empty answers (the server identified, plex.tv
  // answered, nobody shared) while a prior set is cached. One is served stale
  // (a truncated list must not log everyone out); the second replaces the
  // cache, so removing the last friend does take effect.
  emptyStreak: number;
};

// Process-wide (guardrail 27a): this module is reached from the proxy, page
// renders and API routes, each a separate server chunk. Per-chunk state meant a
// plex.tv fetch, a TTL and a backoff PER CHUNK, and windows where one chunk
// enforced a membership another had not fetched yet.
const slugStates = processSingleton("plex-membership:slugStates", () => new Map<MediaInstanceKey, SlugState>());

// Memoized composition of the last returned union, keyed on the contributing
// (slug, fetchedAt) pairs — so repeat calls inside a stable window hand back
// the SAME object (the pre-multi-server zero-allocation hot path).
const composed = processSingleton(
  "plex-membership:composed",
  () => ({ value: null as { key: string; members: PlexServerMembers } | null }),
);

type FetchResult = {
  outcome: AttemptOutcome;
  entry?: CacheEntry;
  // Set on an "indeterminate" answer that is really an authoritative empty
  // list: the admin-only set to cache if the empty answer repeats.
  confirmedEmpty?: CacheEntry;
};

async function fetchSlugAllowlist(slug: MediaInstanceKey, hasPriorSet: boolean): Promise<FetchResult> {
  const [{ url, token }, adminEmailRow] = await Promise.all([
    getPlexConfig(slug),
    prisma.setting.findUnique({ where: { key: plexSettingKey(slug, "AdminEmail") } }),
  ]);
  const adminToken = token?.trim();
  const serverUrl = url?.trim();
  // Unconfigured — this instance cannot be verified and doesn't need to be.
  if (!adminToken || !serverUrl) return { outcome: "unconfigured" };
  // normalizeEmail matches the sign-in gate in auth.ts (authorizeWithPlex) so
  // both membership checks share one normalization of the admin-email Setting.
  const adminEmails = (): Set<string> => {
    const emails = new Set<string>();
    if (adminEmailRow?.value) emails.add(normalizeEmail(adminEmailRow.value));
    return emails;
  };

  // getPlexFriendEmails throws on a non-2xx plex.tv response and returns empty
  // sets when it can't resolve the server's machineId. An empty result would
  // lock out EVERY user of this instance, so treat both-sets-empty as "couldn't
  // determine". (The admin email is added only after this guard so an
  // admin-only server isn't mistaken for a successful-but-empty fetch.)
  const members = await getPlexFriendEmails(adminToken, serverUrl);
  if (members.ids.size === 0 && members.emails.size === 0) {
    // With a prior set cached, tell "nobody is shared any more" (the server
    // identifies itself, so plex.tv's answer was scoped and empty) from "the
    // server couldn't be identified". Only the former may ever replace the set.
    if (!hasPriorSet || !(await getPlexMachineId(serverUrl, adminToken, PLEX_IDENTITY_TIMEOUT_MS))) {
      return { outcome: "indeterminate" };
    }
    return { outcome: "indeterminate", confirmedEmpty: { ids: new Set(), emails: adminEmails(), fetchedAt: Date.now() } };
  }
  for (const email of adminEmails()) members.emails.add(email);
  return { outcome: "ok", entry: { ids: members.ids, emails: members.emails, fetchedAt: Date.now() } };
}

// The cache write for one settled attempt. Pure over `state`.
function applyFetchResult(state: SlugState, res: FetchResult): AttemptOutcome {
  if (res.entry) {
    state.cache = res.entry;
    state.emptyStreak = 0;
  } else if (res.confirmedEmpty && state.cache) {
    state.emptyStreak += 1;
    if (state.emptyStreak >= 2) {
      state.cache = res.confirmedEmpty;
      state.lastOutcome = "ok";
      return "ok";
    }
  } else {
    state.emptyStreak = 0;
  }
  // failed/empty leaves the prior set — serve-stale
  state.lastOutcome = res.outcome;
  return res.outcome;
}

// De-dupe concurrent refreshes of one slug within a replica and back off after
// a failure so a persistent outage doesn't trigger a fetch on every request.
function startSlugRefresh(slug: MediaInstanceKey, state: SlugState, now: number): void {
  state.lastAttemptAt = now;
  const generation = state.generation;
  state.inflight = fetchSlugAllowlist(slug, state.cache !== null)
    .then((res) => {
      // Read with a token that has since been replaced: drop it, so the next
      // call refetches with the new one instead of trusting this for a TTL.
      if (state.generation !== generation) return res.outcome;
      const outcome = applyFetchResult(state, res);
      // An "unconfigured" verdict must NOT arm the backoff: the attempt cost
      // three findUniques and zero plex.tv traffic (the backoff exists to
      // protect plex.tv), and honoring a cached "unconfigured" skip after the
      // admin finishes configuring the instance would return an ENFORCING
      // partial union missing that server's members — mass-revoking them for
      // the rest of the window, the exact failure this module forbids. With
      // the reset, the next call re-reads the slug's config immediately: still
      // unconfigured → skip again (cheap); newly configured → a real fetch
      // that either completes the union or cold-poisons to null (fail open).
      if (outcome === "unconfigured") state.lastAttemptAt = 0;
      return outcome;
    })
    .catch((err) => {
      if (state.generation === generation) {
        state.lastOutcome = "indeterminate";
        state.emptyStreak = 0;
      }
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

// The registered instances with their cache state, every due refresh started
// (not awaited), and slugs that left the registry evicted. Null when the
// registry can't be read — no opinion.
async function consultInstances(now: number): Promise<Array<{ slug: MediaInstanceKey; state: SlugState }> | null> {
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
      state = { cache: null, lastAttemptAt: 0, inflight: null, lastOutcome: null, generation: 0, emptyStreak: 0 };
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
  return consulted;
}

/**
 * Returns the union of the members (plex.tv account ids + emails) currently
 * shared on every configured Plex instance, or null when membership cannot be
 * determined — nothing configured, the registry unreadable, or ANY configured
 * instance cold with a failing/empty fetch — a partial union would mass-revoke
 * that server's users. A null return means callers MUST fail open — do not lock
 * anyone out.
 *
 * Each instance caches per-replica for ALLOWLIST_TTL_MS. On a cold instance the
 * first caller blocks on its plex.tv fetch so enforcement starts immediately;
 * once a set is cached, an expired entry is served stale into the union while a
 * single background refresh runs, so the hot path never blocks on plex.tv again.
 */
export async function getCachedPlexAllowlist(): Promise<PlexServerMembers | null> {
  const consulted = await consultInstances(Date.now());
  if (!consulted) return null;

  const parts: Array<{ slug: MediaInstanceKey; ids: Set<string>; emails: Set<string>; fetchedAt: number }> = [];
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
      parts.push({ slug, ids: state.cache.ids, emails: state.cache.emails, fetchedAt: state.cache.fetchedAt });
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
  if (composed.value && composed.value.key === key) return composed.value.members;
  const members: PlexServerMembers =
    parts.length === 1
      ? { ids: parts[0].ids, emails: parts[0].emails } // single instance: hand back the cached Sets themselves, as before
      : {
          ids: new Set(parts.flatMap((p) => [...p.ids])),
          emails: new Set(parts.flatMap((p) => [...p.emails])),
        };
  composed.value = { key, members };
  return members;
}

/**
 * Each registered Plex instance's OWN members (plex.tv account ids + emails),
 * by slug — the per-instance sets getCachedPlexAllowlist unions, read through
 * the same caches (a cold instance's first fetch is awaited, a stale one is
 * served while it refreshes). An instance whose members are unknown
 * (unconfigured, or cold with a failing/empty fetch) is ABSENT: the caller has
 * no answer for that server alone. Null when the registry can't be read. The
 * Sets are the cache's own — read them, never mutate them.
 */
export async function getCachedPlexMembersByInstance(): Promise<Map<MediaInstanceKey, PlexServerMembers> | null> {
  const consulted = await consultInstances(Date.now());
  if (!consulted) return null;
  const out = new Map<MediaInstanceKey, PlexServerMembers>();
  for (const { slug, state } of consulted) {
    if (!state.cache && state.inflight) await state.inflight;
    if (state.cache) out.set(slug, { ids: state.cache.ids, emails: state.cache.emails });
  }
  return out;
}

/**
 * The admin token of `slug` changed (Connect Plex): its cached members were
 * read with the old token. The set is marked expired rather than dropped, so
 * the last-known membership keeps being enforced (served stale) while the next
 * call refetches with the new token at once — no 30-minute TTL wait, and no
 * fail-open window.
 */
export function expirePlexMembershipCache(slug: MediaInstanceKey): void {
  const state = slugStates.get(slug);
  if (!state) return;
  if (state.cache) state.cache = { ...state.cache, fetchedAt: 0 };
  state.lastAttemptAt = 0;
  // A fetch already in flight read the OLD token: its answer is discarded.
  state.generation += 1;
  state.emptyStreak = 0;
}
