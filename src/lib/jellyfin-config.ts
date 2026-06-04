import "server-only";
import { prisma } from "@/lib/prisma";

// The Jellyfin server URL lives in the `jellyfinUrl` Setting, configured in
// Admin → Settings → Media (the same value library sync uses). This is the
// single source of truth for "where is Jellyfin" — it replaced the former
// JELLYFIN_URL env var so login and sync can't drift apart.
//
// Returns the trimmed URL, or null when Jellyfin isn't configured. Callers
// gate the Jellyfin sign-in surfaces on a non-null result.
export async function getConfiguredJellyfinUrl(): Promise<string | null> {
  const row = await prisma.setting.findUnique({ where: { key: "jellyfinUrl" } });
  const url = row?.value?.trim();
  return url ? url : null;
}
