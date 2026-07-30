import "server-only";
import { prisma } from "@/lib/prisma";
import { type MediaInstanceKey, DEFAULT_MEDIA_INSTANCE, plexSettingKey } from "@/lib/media-instances";

// The plexServerUrl/plexAdminToken Setting pair (or their per-instance
// equivalents), decrypted transparently by the Prisma extension (guardrail 7a
// — no crypto here). Values are returned RAW — no trim, no trailing-slash
// strip — with missing/empty normalized to null, so call sites keep their
// existing post-processing (most do `url.replace(/\/$/, "")` themselves) and
// their `!url || !token` guards behave exactly like the old inline
// `!row?.value` checks. Mirrors getJellyfinConfig() in jellyfin-config.ts.
//
// `instance` defaults to the default server ("") so every existing zero-arg
// caller keeps reading exactly the legacy plexServerUrl/plexAdminToken keys,
// byte-for-byte — multi-server support (Phase 2) is purely additive here.
export async function getPlexConfig(instance: MediaInstanceKey = DEFAULT_MEDIA_INSTANCE): Promise<{ url: string | null; token: string | null }> {
  const [urlRow, tokenRow] = await Promise.all([
    prisma.setting.findUnique({ where: { key: plexSettingKey(instance, "ServerUrl") } }),
    prisma.setting.findUnique({ where: { key: plexSettingKey(instance, "AdminToken") } }),
  ]);
  return { url: urlRow?.value || null, token: tokenRow?.value || null };
}
