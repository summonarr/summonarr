import "server-only";
import { prisma } from "@/lib/prisma";

// The Jellyfin server URL lives in the `jellyfinUrl` Setting (Admin → Settings →
// Media), the single source of truth — it replaced the JELLYFIN_URL env var so
// login and sync can't drift apart. Returns the trimmed URL, or null when
// unconfigured; callers gate the Jellyfin sign-in surfaces on a non-null result.
export async function getConfiguredJellyfinUrl(): Promise<string | null> {
  const row = await prisma.setting.findUnique({ where: { key: "jellyfinUrl" } });
  const url = row?.value?.trim();
  return url ? url : null;
}

// The jellyfinUrl/jellyfinApiKey Setting pair, decrypted transparently by the
// Prisma extension (guardrail 7a — no crypto here). Values are returned RAW —
// no trim, no trailing-slash strip — with missing/empty normalized to null, so
// call sites keep their existing post-processing (most do `url.replace(/\/$/, "")`
// themselves) and their `!url || !apiKey` guards behave exactly like the old
// inline `!row?.value` checks.
export async function getJellyfinConfig(): Promise<{ url: string | null; apiKey: string | null }> {
  const [urlRow, keyRow] = await Promise.all([
    prisma.setting.findUnique({ where: { key: "jellyfinUrl" } }),
    prisma.setting.findUnique({ where: { key: "jellyfinApiKey" } }),
  ]);
  return { url: urlRow?.value || null, apiKey: keyRow?.value || null };
}
