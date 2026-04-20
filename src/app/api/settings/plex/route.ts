import { NextRequest, NextResponse } from "next/server";
import { auth, isTokenExpired } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getPlexUser } from "@/lib/plex";

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session || isTokenExpired(session) || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

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

  return NextResponse.json({ email: plexUser.email, username: plexUser.username });
}

export async function DELETE() {
  const session = await auth();
  if (!session || isTokenExpired(session) || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  await prisma.setting.deleteMany({
    where: { key: { in: ["plexAdminToken", "plexAdminEmail"] } },
  });

  await prisma.plexTokenCache.deleteMany({});
  console.warn("[settings] plexAdminToken removed — cleared PlexTokenCache");

  return NextResponse.json({ ok: true });
}
