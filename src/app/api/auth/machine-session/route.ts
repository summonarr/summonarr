import { NextRequest, NextResponse } from "next/server";
import { createHash, timingSafeEqual, randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { getClientIp } from "@/lib/rate-limit";
import { signSessionJwt } from "@/lib/session-jwt";
import { serializeSessionCookie } from "@/lib/session-cookie";

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

  const sessionId = randomUUID();
  const nowSec = Math.floor(Date.now() / 1000);
  const expiresAt = nowSec + expiresIn;
  const callerIp = getClientIp(req.headers);

  // Bind the JWT to a stable fingerprint so a stolen cookie can't be replayed
  // from a different caller. proxy.ts skips the browser-style fingerprint
  // check for any value starting with "machine:" — replay defense relies on
  // the short lifetime and CRON_SECRET to mint fresh tokens.
  const uaFingerprint =
    "machine:" + createHash("sha256").update(cronSecret).digest("hex").slice(0, 12);

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

  const token = await signSessionJwt(
    {
      id: user.id,
      role: user.role,
      email: user.email,
      name: user.name,
      provider: "machine",
      mediaServer: user.mediaServer ?? null,
      sessionId,
      uaFingerprint,
      isMobile: false,
      deviceLabel: "Machine (API)",
      expiresAt,
    },
    { expiresInSeconds: expiresIn },
  );

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

  // C-4: do NOT return the token in the JSON body. Cookie-only delivery.
  const response = NextResponse.json({ ok: true, expiresAt });
  response.headers.set(
    "Set-Cookie",
    serializeSessionCookie(token, { maxAgeSeconds: expiresIn }),
  );
  return response;
}
