import { NextRequest, NextResponse } from "next/server";
import { encode } from "next-auth/jwt";
import { createHash, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";

function safeCompare(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

const MAX_EXPIRES_IN = 86_400;
const DEFAULT_EXPIRES_IN = 3_600;

export async function POST(req: NextRequest) {
  // Machine session is opt-in; disabled by default to prevent accidental programmatic access
  const featureRow = await prisma.setting.findUnique({ where: { key: "enableMachineSession" } });
  if (featureRow?.value !== "true") {
    return NextResponse.json({ error: "Machine session API is disabled" }, { status: 403 });
  }

  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: "Not configured" }, { status: 503 });
  }
  const authHeader = req.headers.get("authorization") ?? "";
  if (
    !authHeader.startsWith("Bearer ") ||
    !safeCompare(authHeader.slice(7), cronSecret)
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let targetUserId: string | undefined;
  let expiresIn = DEFAULT_EXPIRES_IN;
  try {
    const body = await req.json().catch(() => ({}));
    if (body.userId && typeof body.userId === "string") targetUserId = body.userId;
    if (typeof body.expiresIn === "number") {
      expiresIn = Math.min(Math.max(body.expiresIn, 60), MAX_EXPIRES_IN);
    }
  } catch {

  }

  const user = targetUserId
    ? await prisma.user.findUnique({
        where: { id: targetUserId },
        select: { id: true, name: true, email: true, role: true, mediaServer: true },
      })
    : await prisma.user.findFirst({
        where: { role: "ADMIN" },
        select: { id: true, name: true, email: true, role: true, mediaServer: true },
        orderBy: { createdAt: "asc" },
      });

  if (!user) {
    return NextResponse.json({ error: "No admin user found" }, { status: 404 });
  }
  if (user.role !== "ADMIN") {
    return NextResponse.json({ error: "Target user is not an admin" }, { status: 403 });
  }

  // Cookie name must match what NextAuth expects; the __Secure- prefix is mandatory for HTTPS deployments
  const authUrl = process.env.AUTH_URL ?? process.env.NEXTAUTH_URL ?? "";
  const isSecure = authUrl.startsWith("https://");
  const cookieName = isSecure
    ? "__Secure-authjs.session-token"
    : "authjs.session-token";

  const sessionId = crypto.randomUUID();
  const nowSec = Math.floor(Date.now() / 1000);
  const expiresAt = nowSec + expiresIn;

  const jwtPayload = {
    sub: user.id,
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    provider: "machine",
    mediaServer: user.mediaServer ?? null,
    sessionId,
    expiresAt,
    dbCheckedAt: nowSec,
    isMobile: false,
    deviceLabel: "Machine (API)",
  };

  await prisma.authSession.create({
    data: {
      sessionId,
      userId: user.id,
      deviceType: "desktop",
      deviceLabel: "Machine (API)",
      ipAddress: null,
      expiresAt: new Date(expiresAt * 1000),
    },
  });

  const token = await encode({
    token: jwtPayload,
    secret: process.env.NEXTAUTH_SECRET!,
    maxAge: expiresIn,
    salt: cookieName,
  });

  void logAudit({
    userId: user.id,
    userName: user.name ?? user.email ?? "unknown",
    action: "AUTH_LOGIN",
    target: "auth:machine-session",
    ipAddress: null,
    userAgent: null,
    provider: "machine",
    details: { sessionId, expiresIn, expiresAt },
  });

  const cookieAttribs = [
    `${cookieName}=${token}`,
    "Path=/",
    `Max-Age=${expiresIn}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(isSecure ? ["Secure"] : []),
  ].join("; ");

  const response = NextResponse.json({
    sessionId,
    userId: user.id,
    userName: user.name ?? user.email,
    cookieName,
    token,
    expiresAt,
    expiresIn,
  });
  response.headers.set("Set-Cookie", cookieAttribs);
  return response;
}
