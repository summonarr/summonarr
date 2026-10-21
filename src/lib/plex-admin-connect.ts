import { prisma } from "@/lib/prisma";
import { getPlexUser, type PlexUser } from "@/lib/plex";

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

  await Promise.all([
    prisma.setting.upsert({
      where: { key: "plexAdminToken" },
      update: { value: authToken },
      create: { key: "plexAdminToken", value: authToken },
    }),
    prisma.setting.upsert({
      where: { key: "plexAdminEmail" },
      update: { value: plexUser.email },
      create: { key: "plexAdminEmail", value: plexUser.email },
    }),
  ]);

  // Token cache stores per-user auth decisions; must be cleared whenever the admin token changes
  await prisma.plexTokenCache.deleteMany({});
  console.warn("[settings] plexAdminToken changed — cleared PlexTokenCache");
  return plexUser;
}
