import { prisma } from "./prisma";
import { getJellyfinAllUsers, setJellyfinDownloadPolicy } from "./jellyfin";
import { getJellyfinConfig } from "./jellyfin-config";
import { normalizeEmail } from "./email-normalize";

interface PolicySyncResult {
  source: string;
  upserted: number;
  enforced: number;
  errors: number;
}

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

  const [jellyfinConfig, autoDisableRow] = await Promise.all([
    getJellyfinConfig(),
    prisma.setting.findUnique({ where: { key: "downloadAutoDisableNew" } }),
  ]);

  // When true, new users that appear for the first time are seeded with
  // downloadsEnabled=false instead of inheriting the server's current value.
  // Users already in the DB with downloadsEnabled=true are never touched.
  const autoDisableNew = autoDisableRow?.value === "true";

  if (jellyfinConfig.url && jellyfinConfig.apiKey) {
    try {
      results.push(await syncJellyfinPolicies(jellyfinConfig.url, jellyfinConfig.apiKey, autoDisableNew));
    } catch (err) {
      console.warn("[download-policy] Jellyfin sync task failed:", err instanceof Error ? err.message : String(err));
      // Surface the task-level failure to the caller's error total so the cron
      // run is recorded as not-ok instead of silently reporting green.
      results.push({ source: "jellyfin", upserted: 0, enforced: 0, errors: 1 });
    }
  }

  return results;
}

async function syncJellyfinPolicies(baseUrl: string, apiKey: string, autoDisableNew: boolean): Promise<PolicySyncResult> {
  const result: PolicySyncResult = { source: "jellyfin", upserted: 0, enforced: 0, errors: 0 };

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
      where: { source: "jellyfin" },
      select: { sourceUserId: true, downloadsEnabled: true, active: true },
    }),
    prisma.user.findMany({
      where: {
        email: {
          in: users.flatMap((u) => (u.email ? [normalizeEmail(u.email)] : [])),
        },
      },
      select: { id: true, email: true, mediaServer: true },
    }),
  ]);

  const existingMap = new Map(existingRows.map((r) => [r.sourceUserId, r]));
  const linkedMap = new Map(linkedUsers.map((u) => [u.email, u]));

  for (const u of users) {
    try {
      const existing = existingMap.get(u.id) ?? null;
      const linked = u.email ? (linkedMap.get(normalizeEmail(u.email)) ?? null) : null;
      const userId =
        linked && (!linked.mediaServer || linked.mediaServer.toLowerCase() === "jellyfin")
          ? linked.id
          : null;

      // For new/unsynced users: auto-disable if the setting is on, otherwise seed from server.
      // For existing users with an explicit value: keep it (honors manual flips to true).
      const defaultForNew = autoDisableNew ? false : u.downloadsEnabled;
      const downloadsEnabled = existing?.downloadsEnabled ?? defaultForNew;

      await prisma.mediaServerUser.upsert({
        where: { source_sourceUserId: { source: "jellyfin", sourceUserId: u.id } },
        create: {
          source: "jellyfin",
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

      if (!u.isAdmin && downloadsEnabled === false) {
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
  // writer; no backfill cron exists). Still guard against a degraded fetch:
  // getJellyfinAllUsers only throws on a non-2xx, so a 200 with a truncated/
  // subset list (reduced API-key elevation, transient quirk) would wrongly
  // mass-deactivate everyone absent. Only reconcile when the fetch looks
  // complete: non-empty AND not a suspicious shrink versus the ACTIVE rows we
  // already had (inactive rows accumulate, so comparing against all rows would
  // make the guard read every run as a "shrink").
  const priorActiveCount = existingRows.filter((r) => r.active).length;
  const PRUNE_MAX_SHRINK = 2; // tolerate small genuine departures per run
  const safeToReconcile =
    users.length > 0 && (priorActiveCount === 0 || users.length >= priorActiveCount - PRUNE_MAX_SHRINK);
  if (safeToReconcile) {
    const currentIds = users.map((u) => u.id);
    await prisma.mediaServerUser.updateMany({
      where: { source: "jellyfin", sourceUserId: { notIn: currentIds }, active: true },
      data: { active: false },
    });
  } else if (users.length > 0) {
    console.warn(
      `[download-policy] Skipping Jellyfin user reconcile: fetched ${users.length} users but ${priorActiveCount} were active — refusing to mass-deactivate on a possibly-degraded response`,
    );
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
    select: { source: true, sourceUserId: true, downloadsEnabled: true, isServerAdmin: true, username: true },
  });

  if (!record || record.isServerAdmin || record.downloadsEnabled === null) return;
  if (record.source !== "jellyfin") return;

  const { url, apiKey } = await getJellyfinConfig();
  if (!url || !apiKey) return;
  await setJellyfinDownloadPolicy(url, apiKey, record.sourceUserId, record.downloadsEnabled);
}
