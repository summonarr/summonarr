import { prisma } from "./prisma";
import { getJellyfinAllUsers, setJellyfinDownloadPolicy } from "./jellyfin";
import { getJellyfinConfig } from "./jellyfin-config";
import { normalizeEmail } from "./email-normalize";
import { type MediaInstanceKey, mediaInstanceLabel } from "./media-instances";
import { getSyncableMediaInstances } from "./media-instance-registry";

interface PolicySyncResult {
  source: string;
  upserted: number;
  enforced: number;
  errors: number;
}

// Pure guard for the Jellyfin user reconcile (soft-delete of departed users).
// getJellyfinAllUsers only throws on a non-2xx, so a 200 with a truncated/
// subset list (reduced API-key elevation, transient quirk) would wrongly
// mass-deactivate everyone absent. Only reconcile when the fetch looks
// complete: non-empty AND not a suspicious shrink versus the ACTIVE rows we
// already had (inactive rows accumulate, so comparing against all rows would
// make the guard read every run as a "shrink"). Exported for unit tests.
export const PRUNE_MAX_SHRINK = 2; // tolerate small genuine departures per run
export function isSafeToReconcileJellyfinUsers(fetchedCount: number, priorActiveCount: number): boolean {
  return fetchedCount > 0 && (priorActiveCount === 0 || fetchedCount >= priorActiveCount - PRUNE_MAX_SHRINK);
}

// Escape hatch for the guard above. A genuinely shrinking server (3+ real
// departures in one window) trips the shrink refusal — and because the ONLY
// writer of `active: false` is the reconcile the refusal skips, the departed
// rows stayed active forever, priorActiveCount never shrank, and the warn
// fired every run with no remediation path (a permanent wedge unless enough
// NEW users joined). A degraded fetch, by contrast, is transient noise. Split
// the two by persistence: after the SAME fetched user-id set has been refused
// RECONCILE_CONFIRM_RUNS consecutive runs, accept it as the server's real
// state and reconcile anyway. In-memory per replica (the ledger idiom of
// guardrail 27) — a restart just restarts the count.
export const RECONCILE_CONFIRM_RUNS = 3;
const refusedReconciles = new Map<MediaInstanceKey, { signature: string; runs: number }>();

/**
 * Fetches all users from each configured media server, upserts them into
 * MediaServerUser, and re-enforces any download restrictions set in Summonarr.
 *
 * Plex is intentionally not enforced — the Plex sharing API does not expose a
 * working remote toggle for `allowSync`. Plex users are still upserted by the
 * library/account sync paths so they appear in the admin Users page; download
 * permissions on Plex must be managed in Plex itself.
 *
 * - New Jellyfin users (downloadsEnabled IS NULL): seeded from the server's current value.
 * - Known users with downloadsEnabled = false: policy is pushed to the server even
 *   if someone re-enabled it directly in Jellyfin.
 * - Admins (isServerAdmin = true) are never touched by enforcement.
 */
export async function syncDownloadPolicies(): Promise<PolicySyncResult[]> {
  const results: PolicySyncResult[] = [];

  const [instances, autoDisableRow] = await Promise.all([
    getSyncableMediaInstances("jellyfin"),
    prisma.setting.findUnique({ where: { key: "downloadAutoDisableNew" } }),
  ]);

  // When true, new users that appear for the first time are seeded with
  // downloadsEnabled=false instead of inheriting the server's current value.
  // Users already in the DB with downloadsEnabled=true are never touched.
  const autoDisableNew = autoDisableRow?.value === "true";

  // Sequential, not fan-out: the instance count is admin-configured and small
  // (never library-scaled), so guardrail 31's bounded-concurrency concern
  // doesn't apply — a straightforward loop keeps this simple and avoids two
  // instances' full user-syncs interleaving their own internal work.
  for (const instance of instances) {
    const cfg = await getJellyfinConfig(instance.slug);
    if (!cfg.url || !cfg.apiKey) continue; // defensive; getSyncableMediaInstances already filters to configured ones
    try {
      results.push(await syncJellyfinPolicies(instance.slug, cfg.url, cfg.apiKey, autoDisableNew));
    } catch (err) {
      console.warn(`[download-policy] Jellyfin sync task failed for instance "${instance.slug}":`, err instanceof Error ? err.message : String(err));
      // Surface the task-level failure to the caller's error total so the cron
      // run is recorded as not-ok instead of silently reporting green.
      results.push({ source: mediaInstanceLabel("jellyfin", instance.slug), upserted: 0, enforced: 0, errors: 1 });
    }
  }

  return results;
}

async function syncJellyfinPolicies(instance: MediaInstanceKey, baseUrl: string, apiKey: string, autoDisableNew: boolean): Promise<PolicySyncResult> {
  const result: PolicySyncResult = { source: mediaInstanceLabel("jellyfin", instance), upserted: 0, enforced: 0, errors: 0 };

  let users;
  try {
    users = await getJellyfinAllUsers(baseUrl, apiKey);
  } catch (err) {
    console.warn("[download-policy] Jellyfin user fetch failed:", err instanceof Error ? err.message : String(err));
    // Count the fetch failure so the cron run is recorded as not-ok rather than
    // reporting zero errors on a sync that never actually ran.
    result.errors++;
    return result;
  }

  // Batch-load all existing records and all potentially-linked Summonarr accounts
  // in two queries instead of 2×N individual lookups. Both sides of the join
  // normalize before comparing so Jellyfin's raw email (which may differ in
  // case from the local user's lowercase-stored email) still matches.
  const [existingRows, linkedUsers] = await Promise.all([
    prisma.mediaServerUser.findMany({
      where: { source: "jellyfin", serverInstance: instance },
      select: { sourceUserId: true, downloadsEnabled: true, active: true, manualUserLink: true },
    }),
    prisma.user.findMany({
      where: {
        OR: [
          // Jellyfin's user id is what sign-in pins to User.jellyfinUserId, so it
          // is the authoritative link. Email alone misses every Jellyfin account
          // with no email set on the server (Jellyfin doesn't require one) and
          // every Summonarr row carrying the synthetic jellyfin-<id>@jellyfin.local
          // login address — those users would never be attributed at all.
          { jellyfinUserId: { in: users.map((u) => u.id) } },
          { email: { in: users.flatMap((u) => (u.email ? [normalizeEmail(u.email)] : [])) } },
        ],
      },
      select: { id: true, email: true, mediaServer: true, jellyfinUserId: true },
    }),
  ]);

  const existingMap = new Map(existingRows.map((r) => [r.sourceUserId, r]));
  const linkedMap = new Map(linkedUsers.map((u) => [u.email, u]));
  const linkedBySubMap = new Map(
    linkedUsers.flatMap((u) => (u.jellyfinUserId ? [[u.jellyfinUserId, u] as const] : [])),
  );

  for (const u of users) {
    try {
      const existing = existingMap.get(u.id) ?? null;
      // Subject id first, email second. A subject match needs no mediaServer
      // guard — jellyfinUserId is unique and only Jellyfin sign-in writes it, so
      // there is no cross-provider collision to defend against (unlike an email
      // match, which could be a Plex-pinned user who happens to share the address).
      const linkedBySub = linkedBySubMap.get(u.id) ?? null;
      const linkedByEmail = u.email ? (linkedMap.get(normalizeEmail(u.email)) ?? null) : null;
      const resolved =
        linkedBySub?.id ??
        (linkedByEmail && (!linkedByEmail.mediaServer || linkedByEmail.mediaServer.toLowerCase() === "jellyfin")
          ? linkedByEmail.id
          : null);
      // An admin set this row's account binding by hand — automatic resolution
      // must not overwrite it on the next hourly run.
      const userId = existing?.manualUserLink ? null : resolved;

      // For new/unsynced users: auto-disable if the setting is on, otherwise seed from server.
      // For existing users with an explicit value: keep it (honors manual flips to true).
      const defaultForNew = autoDisableNew ? false : u.downloadsEnabled;
      const downloadsEnabled = existing?.downloadsEnabled ?? defaultForNew;

      await prisma.mediaServerUser.upsert({
        where: { source_serverInstance_sourceUserId: { source: "jellyfin", serverInstance: instance, sourceUserId: u.id } },
        create: {
          source: "jellyfin",
          serverInstance: instance,
          sourceUserId: u.id,
          username: u.name,
          email: u.email ?? null,
          isServerAdmin: u.isAdmin,
          downloadsEnabled,
          ...(userId ? { userId } : {}),
        },
        update: {
          username: u.name,
          ...(u.email ? { email: u.email } : {}),
          isServerAdmin: u.isAdmin,
          active: true, // re-activate a returning user (soft-deleted on a prior departure)
          ...(userId ? { userId } : {}),
          // Write server value only when we have no admin-set value yet (null).
          ...(existing === null || existing.downloadsEnabled === null ? { downloadsEnabled } : {}),
        },
      });
      result.upserted++;

      // Push only on DRIFT — u.downloadsEnabled is the server's CURRENT value
      // from the same /Users fetch this run already made (absent Policy coerces
      // to true, so only an explicit server-side false skips). Pushing when the
      // server already reports disabled was a no-op that still paid the 2-call
      // read-modify-write and re-opened its clobber window (the POST writes the
      // FULL policy object, so a concurrent Jellyfin-dashboard edit of any
      // field between our GET and POST is overwritten with the stale snapshot).
      if (!u.isAdmin && downloadsEnabled === false && u.downloadsEnabled !== false) {
        try {
          await setJellyfinDownloadPolicy(baseUrl, apiKey, u.id, false);
          result.enforced++;
        } catch (err) {
          console.warn(`[download-policy] Jellyfin enforce failed for ${u.name}:`, err instanceof Error ? err.message : String(err));
          result.errors++;
        }
      }
    } catch (err) {
      console.warn(`[download-policy] Jellyfin upsert failed for ${u.name}:`, err instanceof Error ? err.message : String(err));
      result.errors++;
    }
  }

  // Mark users no longer on the Jellyfin server as inactive (soft-delete). We
  // NEVER hard-delete a MediaServerUser — PlayHistory + ActiveSession FK it and
  // play history must survive the user's removal (the live poller is the only
  // writer; no backfill cron exists). isSafeToReconcileJellyfinUsers (above)
  // guards against a degraded (truncated but 200) fetch mass-deactivating
  // everyone absent.
  const priorActiveCount = existingRows.filter((r) => r.active).length;
  let safeToReconcile = isSafeToReconcileJellyfinUsers(users.length, priorActiveCount);
  if (safeToReconcile) {
    refusedReconciles.delete(instance);
  } else if (users.length > 0) {
    // Confirmation counter (see RECONCILE_CONFIRM_RUNS): a degraded fetch is
    // transient; a real mass departure repeats the IDENTICAL user-id set run
    // after run. Only the same signature accumulates — any variation resets.
    const signature = users.map((u) => u.id).sort().join(",");
    const prior = refusedReconciles.get(instance);
    const runs = prior?.signature === signature ? prior.runs + 1 : 1;
    if (runs >= RECONCILE_CONFIRM_RUNS) {
      console.warn(
        `[download-policy] Jellyfin user shrink for instance "${instance}" confirmed across ${runs} runs (fetched ${users.length}, ${priorActiveCount} active) — accepting it as the server's real state and reconciling`,
      );
      safeToReconcile = true;
      refusedReconciles.delete(instance);
    } else {
      refusedReconciles.set(instance, { signature, runs });
      console.warn(
        `[download-policy] Skipping Jellyfin user reconcile for instance "${instance}": fetched ${users.length} users but ${priorActiveCount} were active — refusing to mass-deactivate on a possibly-degraded response (${runs}/${RECONCILE_CONFIRM_RUNS} identical observations)`,
      );
    }
  }
  if (safeToReconcile) {
    const currentIds = users.map((u) => u.id);
    // Scoped by serverInstance — load-bearing (guardrail 28). Without this, a
    // user who exists only on a DIFFERENT Jellyfin server would look "absent"
    // from THIS instance's fetch and get incorrectly soft-deleted, destroying
    // their attribution to play history that survives on the other server.
    await prisma.mediaServerUser.updateMany({
      where: { source: "jellyfin", serverInstance: instance, sourceUserId: { notIn: currentIds }, active: true },
      data: { active: false },
    });
  }

  return result;
}

/**
 * Push a single user's download policy to their media server immediately.
 * Called by the per-user toggle API route. Jellyfin only — Plex is unsupported.
 */
export async function enforceUserDownloadPolicy(mediaServerUserId: string): Promise<void> {
  const record = await prisma.mediaServerUser.findUnique({
    where: { id: mediaServerUserId },
    select: { source: true, serverInstance: true, sourceUserId: true, downloadsEnabled: true, isServerAdmin: true, username: true },
  });

  if (!record || record.isServerAdmin || record.downloadsEnabled === null) return;
  if (record.source !== "jellyfin") return;

  // Resolve THIS row's own server, not always the default — a toggle on a
  // named-instance user must push to that instance, never instance "".
  const { url, apiKey } = await getJellyfinConfig(record.serverInstance);
  if (!url || !apiKey) return;
  await setJellyfinDownloadPolicy(url, apiKey, record.sourceUserId, record.downloadsEnabled);
}
