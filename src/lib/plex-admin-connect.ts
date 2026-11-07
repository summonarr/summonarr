import { prisma } from "@/lib/prisma";
import { getPlexUser, type PlexUser } from "@/lib/plex";
import { DEFAULT_MEDIA_INSTANCE, plexSettingKey } from "@/lib/media-instances";
import { expirePlexMembershipCache } from "@/lib/plex-membership";

// Validates a Plex token against plex.tv and stores it as the admin (owner)
// token. Shared by POST /api/settings/plex and the server-side connect poll
// (PATCH /api/auth/plex/pin), so both write the same rows the same way.
//
// Returns null when plex.tv rejects the token (or is unreachable) — BEFORE any
// Setting write. `logScope` keeps each caller's own log prefix.
export async function savePlexAdminToken(authToken: string, logScope: string): Promise<PlexUser | null> {
  let plexUser: PlexUser;
  try {
    plexUser = await getPlexUser(authToken);
  } catch (err) {
    console.error(`[${logScope}] Plex token validation failed:`, err);
    return null;
  }

  const tokenKey = plexSettingKey(DEFAULT_MEDIA_INSTANCE, "AdminToken");
  const emailKey = plexSettingKey(DEFAULT_MEDIA_INSTANCE, "AdminEmail");
  // One transaction, one statement at a time (guardrail 23c), no swallowed
  // error inside it (guardrail 23): the token, the owner's email (the sign-in
  // allowlist's admin entry) and the cleared PlexTokenCache — per-user auth
  // decisions made under the OLD token — land together or not at all. Raw
  // values: the Prisma extension encrypts the token (guardrail 7a).
  await prisma.$transaction(async (tx) => {
    await tx.setting.upsert({
      where: { key: tokenKey },
      update: { value: authToken },
      create: { key: tokenKey, value: authToken },
    });
    await tx.setting.upsert({
      where: { key: emailKey },
      update: { value: plexUser.email },
      create: { key: emailKey, value: plexUser.email },
    });
    await tx.plexTokenCache.deleteMany({});
  });
  // The server's member allowlist was read with the old token: refetch it now
  // rather than after its 30-minute TTL.
  expirePlexMembershipCache(DEFAULT_MEDIA_INSTANCE);
  // Not a success log: it lets an operator correlate sign-in decisions that
  // re-run against plex.tv with the rotation (DELETE /api/settings/plex warns
  // the same way). Under the caller's own prefix.
  console.warn(`[${logScope}] plexAdminToken changed — cleared PlexTokenCache`);
  return plexUser;
}
