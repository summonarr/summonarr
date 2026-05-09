// TODO(security): purgeExpiredPlexTokens() is exported but not yet wired into
// any cron route. A future change should add it to the existing maintenance
// cron (or the daily sweep route) so expired rows actually get reaped.

import { NextResponse } from "next/server";
import { auth } from "./auth";
import { prisma } from "./prisma";

export async function getMaintenanceStatus(): Promise<{ enabled: boolean; message: string }> {
  try {
    const rows = await prisma.setting.findMany({
      where: { key: { in: ["maintenanceEnabled", "maintenanceMessage"] } },
    });
    const cfg = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    return {
      enabled: cfg.maintenanceEnabled === "true",
      message: cfg.maintenanceMessage ?? "",
    };
  } catch {
    return { enabled: false, message: "" };
  }
}

export async function maintenanceGuard(): Promise<NextResponse | null> {
  // Read role from session inside the guard rather than trusting a caller-supplied value.
  // NextAuth resolves the session from cookies/JWT without a DB hit, so the cost is negligible
  // even when the caller has already invoked auth() for its own purposes.
  const session = await auth();
  if (session?.user?.role === "ADMIN") return null;
  const { enabled, message } = await getMaintenanceStatus();
  if (!enabled) return null;
  return NextResponse.json(
    { error: "Service unavailable", message: message || "Under maintenance" },
    { status: 503 }
  );
}

/**
 * Sweep expired Plex token cache rows. Each row stores a SHA-256 hash of a
 * Plex authToken verified against /api/v2/user; expiresAt is set to lastUsedAt
 * + 90 days on insert/update. Rows older than that should be dropped so a
 * stolen-but-stale token hash can't be used to skip the Plex-side device
 * check on a fresh sign-in.
 *
 * Legacy rows from before the TTL migration have expiresAt=NULL; those are
 * also purged here. The worst case for a purged null row is one extra
 * /api/v2/user call against Plex on the affected user's next sign-in.
 */
export async function purgeExpiredPlexTokens(): Promise<{ deleted: number }> {
  try {
    const result = await prisma.plexTokenCache.deleteMany({
      where: {
        OR: [
          { expiresAt: { lt: new Date() } },
          { expiresAt: null },
        ],
      },
    });
    return { deleted: result.count };
  } catch (err) {
    console.error("[maintenance] purgeExpiredPlexTokens failed:", err);
    return { deleted: 0 };
  }
}
