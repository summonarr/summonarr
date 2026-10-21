import { NextResponse } from "next/server";
import { readJsonCapped } from "@/lib/body-size";
import { withAdmin } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { savePlexAdminToken } from "@/lib/plex-admin-connect";
import { logAudit } from "@/lib/audit";
import { getClientIp } from "@/lib/rate-limit";
import { translatorForRequest } from "@/lib/i18n/server-locale";

export const POST = withAdmin(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  const parsed = await readJsonCapped<{ authToken?: string }>(req, 16384);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed;

  if (!body.authToken || typeof body.authToken !== "string") {
    return NextResponse.json({ error: t("apiAdmin.settings.authTokenRequired") }, { status: 400 });
  }

  // Validate the token against plex.tv BEFORE any Setting write. A bad/expired
  // token or an unreachable plex.tv maps to a clean 422 (mirrors the settings
  // PATCH route's plexError semantics) instead of an unhandled 500.
  const plexUser = await savePlexAdminToken(body.authToken, "settings/plex");
  if (!plexUser) {
    return NextResponse.json(
      { error: t("apiAdmin.settings.plexTokenInvalid") },
      { status: 422 },
    );
  }

  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email ?? null,
    action: "SETTINGS_CHANGE",
    target: "settings:plex",
    details: { keys: ["plexAdminToken", "plexAdminEmail"], operation: "rotate" },
    ipAddress: getClientIp(req.headers),
    userAgent: req.headers.get("user-agent"),
    provider: session.user.provider ?? null,
  });

  return NextResponse.json({ email: plexUser.email, username: plexUser.username });
});

export const DELETE = withAdmin(async (req, _ctx, session) => {
  await prisma.setting.deleteMany({
    where: { key: { in: ["plexAdminToken", "plexAdminEmail"] } },
  });

  await prisma.plexTokenCache.deleteMany({});
  console.warn("[settings] plexAdminToken removed — cleared PlexTokenCache");

  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email ?? null,
    action: "SETTINGS_CHANGE",
    target: "settings:plex",
    details: { keys: ["plexAdminToken", "plexAdminEmail"], operation: "delete" },
    ipAddress: getClientIp(req.headers),
    userAgent: req.headers.get("user-agent"),
    provider: session.user.provider ?? null,
  });

  return NextResponse.json({ ok: true });
});
