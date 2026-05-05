import { prisma } from "./prisma";
import { getJellyfinAllUsers, setJellyfinDownloadPolicy } from "./jellyfin";

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

  const [jellyfinUrlRow, jellyfinKeyRow, autoDisableRow] = await Promise.all([
    prisma.setting.findUnique({ where: { key: "jellyfinUrl" } }),
    prisma.setting.findUnique({ where: { key: "jellyfinApiKey" } }),
    prisma.setting.findUnique({ where: { key: "downloadAutoDisableNew" } }),
  ]);

  // When true, new users that appear for the first time are seeded with
  // downloadsEnabled=false instead of inheriting the server's current value.
  // Users already in the DB with downloadsEnabled=true are never touched.
  const autoDisableNew = autoDisableRow?.value === "true";

  if (jellyfinUrlRow?.value && jellyfinKeyRow?.value) {
    try {
      results.push(await syncJellyfinPolicies(jellyfinUrlRow.value, jellyfinKeyRow.value, autoDisableNew));
    } catch (err) {
      console.warn("[download-policy] Jellyfin sync task failed:", err instanceof Error ? err.message : String(err));
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
    return result;
  }

  // Batch-load all existing records and all potentially-linked Summonarr accounts
  // in two queries instead of 2×N individual lookups.
  const [existingRows, linkedUsers] = await Promise.all([
    prisma.mediaServerUser.findMany({
      where: { source: "jellyfin" },
      select: { sourceUserId: true, downloadsEnabled: true },
    }),
    prisma.user.findMany({
      where: {
        email: {
          in: users.flatMap((u) => (u.email ? [u.email] : [])),
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
      const linked = u.email ? (linkedMap.get(u.email) ?? null) : null;
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

  // Remove users no longer on the Jellyfin server. Guard against empty list
  // to avoid nuking everyone if the API call silently returns nothing.
  if (users.length > 0) {
    const currentIds = users.map((u) => u.id);
    await prisma.mediaServerUser.deleteMany({
      where: { source: "jellyfin", sourceUserId: { notIn: currentIds } },
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
    select: { source: true, sourceUserId: true, downloadsEnabled: true, isServerAdmin: true, username: true },
  });

  if (!record || record.isServerAdmin || record.downloadsEnabled === null) return;
  if (record.source !== "jellyfin") return;

  const [urlRow, keyRow] = await Promise.all([
    prisma.setting.findUnique({ where: { key: "jellyfinUrl" } }),
    prisma.setting.findUnique({ where: { key: "jellyfinApiKey" } }),
  ]);
  if (!urlRow?.value || !keyRow?.value) return;
  await setJellyfinDownloadPolicy(urlRow.value, keyRow.value, record.sourceUserId, record.downloadsEnabled);
}
