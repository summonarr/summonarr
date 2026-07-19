import { NextResponse } from "next/server";
import { readJsonCapped } from "@/lib/body-size";
import { withAdmin } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { getPlexUser } from "@/lib/plex";
import { logAudit } from "@/lib/audit";
import { getClientIp } from "@/lib/rate-limit";

export const POST = withAdmin(async (req, _ctx, session) => {
  const parsed = await readJsonCapped<{ authToken?: string }>(req, 16384);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed;

  if (!body.authToken || typeof body.authToken !== "string") {
    return NextResponse.json({ error: "authToken is required" }, { status: 400 });
  }

  const authToken = body.authToken;
  // Validate the token against plex.tv BEFORE any Setting write. getPlexUser
  // throws on a bad/expired token or an unreachable plex.tv — map that to a
  // clean 422 (mirrors the settings PATCH route's plexError semantics) instead
  // of an unhandled 500.
  let plexUser: Awaited<ReturnType<typeof getPlexUser>>;
  try {
    plexUser = await getPlexUser(authToken);
  } catch (err) {
    console.error("[settings/plex] Plex token validation failed:", err);
    return NextResponse.json(
      { error: "Plex token is invalid or plex.tv could not be reached" },
      { status: 422 },
    );
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
