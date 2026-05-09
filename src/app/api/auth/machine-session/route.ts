import { NextRequest, NextResponse } from "next/server";
import { encode } from "next-auth/jwt";
import { createHash, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { getClientIp } from "@/lib/rate-limit";

function safeCompare(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

// C-4: cap to 15 minutes. Machine sessions are short-lived by intent;
// a leaked token shouldn't grant 24 hours of admin access.
const MAX_EXPIRES_IN = 900;
const DEFAULT_EXPIRES_IN = 900;

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

  // C-4: do not let the caller pick a userId. Always issue for the first ADMIN.
  let expiresIn = DEFAULT_EXPIRES_IN;
  try {
    const body = await req.json().catch(() => ({}));
    if (typeof body?.expiresIn === "number") {
      expiresIn = Math.min(Math.max(body.expiresIn, 60), MAX_EXPIRES_IN);
    }
  } catch {
    // ignore — body is optional
  }

  const user = await prisma.user.findFirst({
    where: { role: "ADMIN" },
    select: { id: true, name: true, email: true, role: true, mediaServer: true },
    orderBy: { createdAt: "asc" },
  });

  if (!user) {
    return NextResponse.json({ error: "No admin user found" }, { status: 404 });
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
  const callerIp = getClientIp(req.headers);

  // Bind the JWT to a stable fingerprint so a stolen cookie can't be replayed
  // from a different caller; auth.config.ts:55-74 compares this on every request.
  const uaFingerprint =
    "machine:" + createHash("sha256").update(cronSecret).digest("hex").slice(0, 12);

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
    uaFingerprint,
  };

  await prisma.authSession.create({
    data: {
      sessionId,
      userId: user.id,
      deviceType: "desktop",
      deviceLabel: "Machine (API)",
      ipAddress: callerIp,
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
    userName: "machine",
    action: "AUTH_LOGIN",
    target: `user:${user.id}`,
    ipAddress: callerIp,
    userAgent: req.headers.get("user-agent")?.slice(0, 512) ?? null,
    provider: "machine",
    sessionId,
    details: { kind: "machine-session", expiresIn, expiresAt },
  });

  const cookieAttribs = [
    `${cookieName}=${token}`,
    "Path=/",
    `Max-Age=${expiresIn}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(isSecure ? ["Secure"] : []),
  ].join("; ");

  // C-4: do NOT return the token in the JSON body. Cookie-only delivery.
  const response = NextResponse.json({ ok: true, expiresAt });
  response.headers.set("Set-Cookie", cookieAttribs);
  return response;
}
