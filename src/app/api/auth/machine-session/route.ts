import { NextRequest, NextResponse } from "next/server";
import { readJsonCappedOr } from "@/lib/body-size";
import { createHash, timingSafeEqual, randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { parseIpAllowlist, isIpAllowed } from "@/lib/ip-allowlist";
import { signSessionJwt } from "@/lib/session-jwt";
import { serializeSessionCookie } from "@/lib/session-cookie";

function safeCompare(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

// Hard cap on a machine session's lifetime: 15 minutes (900s). A machine session
// impersonates an admin, so its token is effectively an admin credential. These
// sessions are minted on demand for short automated tasks, so there is no reason
// to grant a long-lived token — and a tight cap bounds the blast radius if one
// leaks (from logs, a CI artifact, process memory, etc.): a stolen token expires
// in at most 15 minutes instead of granting hours of admin access. A caller may
// request a shorter lifetime, but never a longer one — anything above this is
// clamped down to MAX_EXPIRES_IN below.
const MAX_EXPIRES_IN = 900;
const DEFAULT_EXPIRES_IN = 900;

export async function POST(req: NextRequest) {
  const callerIp = getClientIp(req.headers);
  // Throttle per IP as defense-in-depth against CRON_SECRET brute-force (on top
  // of the timing-safe compare below). Legitimate machine sessions are minted
  // infrequently, so a tight limit costs real callers nothing.
  if (!checkRateLimit(`machine-session:${callerIp}`, 10, 60_000)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  // Machine session is opt-in; disabled by default to prevent accidental programmatic access
  const featureRow = await prisma.setting.findUnique({ where: { key: "enableMachineSession" } });
  if (featureRow?.value !== "true") {
    return NextResponse.json({ error: "Machine session API is disabled" }, { status: 403 });
  }

  // Optional IP allowlist. When set, only listed IPs/CIDRs may mint a session —
  // checked before the secret compare so off-allowlist callers never reach it.
  // Fail-closed: an indeterminate callerIp ("unknown" when TRUST_PROXY is off or
  // no X-Forwarded-For is present) never matches, so the allowlist requires a
  // trusted proxy to be useful.
  const allowRow = await prisma.setting.findUnique({ where: { key: "machineSessionAllowedIps" } });
  const allowlist = parseIpAllowlist(allowRow?.value);
  if (allowlist.length > 0 && !isIpAllowed(callerIp, allowlist)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
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
  const body = await readJsonCappedOr<{ expiresIn?: number; userId?: string }>(req, 8192, {});
  if (body instanceof NextResponse) return body;
  if (typeof body?.expiresIn === "number") {
    expiresIn = Math.min(Math.max(body.expiresIn, 60), MAX_EXPIRES_IN);
  }

  // Optional explicit target admin. When omitted, default to the oldest admin
  // (backward compatible). When provided, the named user MUST exist AND be an
  // ADMIN — the machine session always impersonates an admin, never an
  // arbitrary or lower-privileged account.
  const requestedUserId =
    typeof body?.userId === "string" && body.userId.length > 0 ? body.userId : null;

  const user = requestedUserId
    ? await prisma.user.findUnique({
        where: { id: requestedUserId },
        select: { id: true, name: true, email: true, role: true, mediaServer: true },
      })
    : await prisma.user.findFirst({
        where: { role: "ADMIN" },
        select: { id: true, name: true, email: true, role: true, mediaServer: true },
        orderBy: { createdAt: "asc" },
      });

  if (!user) {
    return NextResponse.json(
      { error: requestedUserId ? "User not found" : "No admin user found" },
      { status: 404 },
    );
  }
  if (requestedUserId && user.role !== "ADMIN") {
    return NextResponse.json(
      { error: "Requested user is not an admin" },
      { status: 403 },
    );
  }

  const sessionId = randomUUID();
  const nowSec = Math.floor(Date.now() / 1000);
  const expiresAt = nowSec + expiresIn;

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
    // Attribute to the machine principal, not the admin whose identity the
    // session assumes — keeps machine logins out of that admin's activity
    // timeline. The assumed admin is preserved in target/details for forensics.
    userId: null,
    userName: "machine",
    action: "AUTH_LOGIN",
    target: `user:${user.id}`,
    ipAddress: callerIp,
    userAgent: req.headers.get("user-agent")?.slice(0, 512) ?? null,
    provider: "machine",
    sessionId,
    details: { kind: "machine-session", assumedAdmin: user.id, expiresIn, expiresAt },
  });

  // Deliver the session token ONLY as an HttpOnly Set-Cookie, never in the JSON
  // response body. Returning the raw admin-impersonating JWT in the body would
  // expose it to anything that can read the response (client-side JS, logging
  // proxies, browser history/devtools, CI logs that capture stdout), defeating the
  // HttpOnly protection that keeps the cookie out of script reach. The body carries
  // only the non-sensitive expiry so the caller knows when to re-mint.
  const response = NextResponse.json({ ok: true, expiresAt });
  response.headers.set(
    "Set-Cookie",
    serializeSessionCookie(token, { maxAgeSeconds: expiresIn }),
  );
  return response;
}
