import "server-only";
import { prisma } from "@/lib/prisma";

// The plexServerUrl/plexAdminToken Setting pair, decrypted transparently by the
// Prisma extension (guardrail 7a — no crypto here). Values are returned RAW —
// no trim, no trailing-slash strip — with missing/empty normalized to null, so
// call sites keep their existing post-processing (most do `url.replace(/\/$/, "")`
// themselves) and their `!url || !token` guards behave exactly like the old
// inline `!row?.value` checks. Mirrors getJellyfinConfig() in jellyfin-config.ts.
export async function getPlexConfig(): Promise<{ url: string | null; token: string | null }> {
  const [urlRow, tokenRow] = await Promise.all([
    prisma.setting.findUnique({ where: { key: "plexServerUrl" } }),
    prisma.setting.findUnique({ where: { key: "plexAdminToken" } }),
  ]);
  return { url: urlRow?.value || null, token: tokenRow?.value || null };
}
