import { NextResponse, type NextRequest } from "next/server";
import { readJsonCapped } from "@/lib/body-size";
import { withAdmin, type SummonarrSession } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { savePlexAdminToken } from "@/lib/plex-admin-connect";
import { DEFAULT_MEDIA_INSTANCE, plexSettingKey } from "@/lib/media-instances";
import { expirePlexMembershipCache } from "@/lib/plex-membership";
import { logAudit } from "@/lib/audit";
import { getClientIp } from "@/lib/rate-limit";
import { translatorForRequest } from "@/lib/i18n/server-locale";

// The default server's admin (owner) token and the owner's email (the sign-in
// allowlist's admin entry).
const TOKEN_KEY = plexSettingKey(DEFAULT_MEDIA_INSTANCE, "AdminToken");
const EMAIL_KEY = plexSettingKey(DEFAULT_MEDIA_INSTANCE, "AdminEmail");

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

  void logAudit(plexTokenAudit(req, session, "rotate"));
  return NextResponse.json({ email: plexUser.email, username: plexUser.username });
});

export const DELETE = withAdmin(async (req, _ctx, session) => {
  // The token, its email and PlexTokenCache — per-user sign-in decisions made
  // under that token — go together or not at all, like savePlexAdminToken's
  // write. One statement at a time, nothing caught inside (guardrails 23, 23c).
  await prisma.$transaction(async (tx) => {
    await tx.setting.deleteMany({ where: { key: { in: [TOKEN_KEY, EMAIL_KEY] } } });
    await tx.plexTokenCache.deleteMany({});
  });
  // The server's member allowlist was read with the removed token: drop it now
  // rather than let it gate Plex sign-ins until its 30-minute TTL.
  expirePlexMembershipCache(DEFAULT_MEDIA_INSTANCE);
  console.warn("[settings] plexAdminToken removed — cleared PlexTokenCache");

  void logAudit(plexTokenAudit(req, session, "delete"));
  return NextResponse.json({ ok: true });
});

// Both verbs' SETTINGS_CHANGE row: the keys and the operation, never the token.
function plexTokenAudit(req: NextRequest, session: SummonarrSession, operation: "rotate" | "delete") {
  return {
    userId: session.user.id,
    userName: session.user.name ?? session.user.email ?? null,
    action: "SETTINGS_CHANGE" as const,
    target: "settings:plex",
    details: { keys: [TOKEN_KEY, EMAIL_KEY], operation },
    ipAddress: getClientIp(req.headers),
    // The column is 512 characters; a longer header failed the audit write.
    userAgent: req.headers.get("user-agent")?.slice(0, 512) ?? null,
    provider: session.user.provider ?? null,
  };
}
