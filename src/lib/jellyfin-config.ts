import "server-only";
import { prisma } from "@/lib/prisma";
import { type MediaInstanceKey, DEFAULT_MEDIA_INSTANCE, jellyfinSettingKey } from "@/lib/media-instances";

// The Jellyfin server URL lives in the `jellyfinUrl` Setting (Admin → Settings →
// Media), the single source of truth — it replaced the JELLYFIN_URL env var so
// login and sync can't drift apart. Returns the trimmed URL, or null when
// unconfigured; callers gate the Jellyfin sign-in surfaces on a non-null result.
//
// `instance` defaults to the default server (""), so a call with no argument
// reads exactly the legacy `jellyfinUrl` key (guardrail 35).
export async function getConfiguredJellyfinUrl(instance: MediaInstanceKey = DEFAULT_MEDIA_INSTANCE): Promise<string | null> {
  const row = await prisma.setting.findUnique({ where: { key: jellyfinSettingKey(instance, "Url") } });
  return normalizedUrl(row?.value);
}

/** Trimmed, null when blank — the one URL normalization both readers share. */
function normalizedUrl(value: string | null | undefined): string | null {
  const url = value?.trim();
  return url ? url : null;
}

// The jellyfinUrl/jellyfinApiKey Setting pair (or their per-instance
// equivalents), decrypted transparently by the Prisma extension (guardrail 7a
// — no crypto here). The URL is normalized exactly as getConfiguredJellyfinUrl
// does it (trimmed, whitespace-only = unconfigured), so the two never disagree
// on whether a server is set up; there is no trailing-slash strip, so call
// sites keep their own `url.replace(/\/$/, "")`. The API key is returned raw,
// with missing/empty normalized to null.
export async function getJellyfinConfig(instance: MediaInstanceKey = DEFAULT_MEDIA_INSTANCE): Promise<{ url: string | null; apiKey: string | null }> {
  const [urlRow, keyRow] = await Promise.all([
    prisma.setting.findUnique({ where: { key: jellyfinSettingKey(instance, "Url") } }),
    prisma.setting.findUnique({ where: { key: jellyfinSettingKey(instance, "ApiKey") } }),
  ]);
  return { url: normalizedUrl(urlRow?.value), apiKey: keyRow?.value || null };
}
