import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { getPlexUser } from "@/lib/plex";
import { logAudit } from "@/lib/audit";
import { getClientIp } from "@/lib/rate-limit";

export const POST = withAdmin(async (req, _ctx, session) => {
  let body: { authToken?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.authToken || typeof body.authToken !== "string") {
    return NextResponse.json({ error: "authToken is required" }, { status: 400 });
  }

  const authToken = body.authToken;
  const plexUser = await getPlexUser(authToken);

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

  await logAudit({
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

  await logAudit({
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
