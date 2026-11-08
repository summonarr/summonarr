import { NextRequest, NextResponse } from "next/server";
import { readOptionalJsonCapped } from "@/lib/body-size";
import { createHash, randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { checkRateLimit, getClientIp, ipBucketKey } from "@/lib/rate-limit";
import { parseIpAllowlist, isIpAllowed } from "@/lib/ip-allowlist";
import { signSessionJwt } from "@/lib/session-jwt";
import { serializeSessionCookie } from "@/lib/session-cookie";
import { serializePermissions } from "@/lib/permissions";
import { safeCompareStrings } from "@/lib/safe-compare";
import { translatorForRequest } from "@/lib/i18n/server-locale";

// Hard cap on a machine session's lifetime: 15 minutes (900s). The token is
// effectively an admin credential, so a tight cap bounds the blast radius if it
// leaks. A caller may request a shorter lifetime but never a longer one — anything
// above this is clamped to MAX_EXPIRES_IN below.
const MAX_EXPIRES_IN = 900;
const DEFAULT_EXPIRES_IN = 900;
const MIN_EXPIRES_IN = 60;

const MACHINE_DEVICE_LABEL = "Machine (API)";

// `permissions` MUST be selected and carried into the JWT — see the note at the
// signSessionJwt call.
const ADMIN_SELECT = { id: true, name: true, email: true, role: true, mediaServer: true, permissions: true, deactivatedAt: true } as const;

export async function POST(req: NextRequest) {
  const t = translatorForRequest(req);
  const callerIp = getClientIp(req.headers);
  // Throttle per IP as defense-in-depth against CRON_SECRET brute-force (on top
  // of the timing-safe compare below). Legitimate machine sessions are minted
  // infrequently, so a tight limit costs real callers nothing.
  // ipBucketKey for the THROTTLE (an IPv6 /64 holder must not rotate past it);
  // the exact callerIp is kept for the isIpAllowed check + audit rows below.
  if (!checkRateLimit(`machine-session:${ipBucketKey(callerIp)}`, 10, 60_000)) {
    return NextResponse.json({ error: t("apiAuth.common.tooManyRequests") }, { status: 429 });
  }

  // Optional IP allowlist. When set, only listed IPs/CIDRs may mint a session —
  // checked before the secret compare so off-allowlist callers never reach it.
  // Fail-closed: an indeterminate callerIp ("unknown" when TRUST_PROXY is off or
  // no X-Forwarded-For is present) never matches, so the allowlist requires a
  // trusted proxy to be useful.
  const allowRow = await prisma.setting.findUnique({ where: { key: "machineSessionAllowedIps" } });
  const allowlist = parseIpAllowlist(allowRow?.value);
  if (allowlist.length > 0 && !isIpAllowed(callerIp, allowlist)) {
    return NextResponse.json({ error: t("apiAuth.common.forbidden") }, { status: 403 });
  }

  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: t("apiAuth.machine.notConfigured") }, { status: 503 });
  }
  const authHeader = req.headers.get("authorization") ?? "";
  if (!authHeader.startsWith("Bearer ") || !safeCompareStrings(authHeader.slice(7), cronSecret)) {
    return NextResponse.json({ error: t("apiAuth.common.unauthorized") }, { status: 401 });
  }

  // Machine session is opt-in; disabled by default to prevent accidental
  // programmatic access. Decided after the secret, so only a holder of it
  // learns whether the feature is on.
  const featureRow = await prisma.setting.findUnique({ where: { key: "enableMachineSession" } });
  if (featureRow?.value !== "true") {
    return NextResponse.json({ error: t("apiAuth.machine.disabled") }, { status: 403 });
  }

  // A bodiless POST takes the defaults. A body that was sent must be meant: an
  // unparseable one, or a userId/expiresIn of the wrong type, is a 400 — never
  // silently the defaults, which would mint for the OLDEST admin instead of the
  // userId the caller named.
  const body = await readOptionalJsonCapped<{ expiresIn?: unknown; userId?: unknown }>(req, 8192, {});
  if (body instanceof NextResponse) return body;
  if (
    (body.userId !== undefined && (typeof body.userId !== "string" || body.userId.length === 0)) ||
    (body.expiresIn !== undefined && (typeof body.expiresIn !== "number" || !Number.isFinite(body.expiresIn)))
  ) {
    return NextResponse.json({ error: t("apiAdmin.common.invalidBody") }, { status: 400 });
  }
  const expiresIn = clampExpiresIn(body.expiresIn);
  const requestedUserId = typeof body.userId === "string" ? body.userId : null;

  const user = await resolveTargetAdmin(requestedUserId);
  if (!user) {
    return NextResponse.json(
      { error: requestedUserId ? t("apiAuth.machine.userNotFound") : t("apiAuth.machine.noAdmin") },
      { status: 404 },
    );
  }
  if (requestedUserId && user.role !== "ADMIN") {
    return NextResponse.json(
      { error: t("apiAuth.machine.notAdmin") },
      { status: 403 },
    );
  }
  if (user.deactivatedAt) {
    return NextResponse.json({ error: t("apiAuth.machine.accountDisabled") }, { status: 403 });
  }

  const { token, sessionId, expiresAt } = await mintMachineSession(user, callerIp, expiresIn, allowlist);

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

  // Deliver the session token ONLY as an HttpOnly Set-Cookie, never in the body —
  // a body would expose the admin-impersonating JWT to anything that can read the
  // response (JS, logging proxies, CI logs), defeating HttpOnly. The body carries
  // only the non-sensitive expiry so the caller knows when to re-mint.
  const response = NextResponse.json({ ok: true, expiresAt });
  response.headers.set(
    "Set-Cookie",
    serializeSessionCookie(token, { maxAgeSeconds: expiresIn }),
  );
  return response;
}

// Whole seconds only: the value is interpolated verbatim into the cookie's
// Max-Age, and RFC 6265 §5.2.2 makes a cookie jar IGNORE a Max-Age with a
// non-digit in it — a fractional request produced a cookie with NO expiry
// instead of a shorter one. The clamp bounds the range, the floor the type.
function clampExpiresIn(requested: unknown): number {
  if (typeof requested !== "number") return DEFAULT_EXPIRES_IN;
  return Math.min(Math.max(Math.floor(requested), MIN_EXPIRES_IN), MAX_EXPIRES_IN);
}

// Optional explicit target admin. When omitted, default to the oldest admin
// (backward compatible). When provided, the named user MUST exist AND be an
// ADMIN (checked by the caller) — the machine session always impersonates an
// admin, never an arbitrary or lower-privileged account.
function resolveTargetAdmin(requestedUserId: string | null) {
  return requestedUserId
    ? prisma.user.findUnique({ where: { id: requestedUserId }, select: ADMIN_SELECT })
    : prisma.user.findFirst({
        // A disabled admin must never back a machine session — account removal
        // keeps `role` intact (see account-lifecycle.ts), so without this filter
        // the fallback could impersonate an admin who has been turned off.
        where: { role: "ADMIN", deactivatedAt: null },
        select: ADMIN_SELECT,
        orderBy: { createdAt: "asc" },
      });
}

type MachineAdmin = NonNullable<Awaited<ReturnType<typeof resolveTargetAdmin>>>;

// The AuthSession row and its signed cookie token.
async function mintMachineSession(user: MachineAdmin, callerIp: string, expiresIn: number, allowlist: string[]) {
  const sessionId = randomUUID();
  const expiresAt = Math.floor(Date.now() / 1000) + expiresIn;

  // A per-session "machine:" fingerprint, so the claim never reads as a browser
  // family. Informational only — nothing compares fingerprints since guardrail
  // 6h; replay defence is the short lifetime and the IP allowlist claim below.
  const uaFingerprint =
    "machine:" + createHash("sha256").update(sessionId).digest("hex").slice(0, 12);

  await prisma.authSession.create({
    data: {
      sessionId,
      userId: user.id,
      deviceType: "desktop",
      deviceLabel: MACHINE_DEVICE_LABEL,
      ipAddress: callerIp,
      expiresAt: new Date(expiresAt * 1000),
    },
  });

  // The `permissions` claim is REQUIRED, not optional. verifyAndRefreshSession
  // compares the claim against the DB mask and treats any difference as a
  // privilege change: it rotates AuthSession.sessionId AND bumps the user's
  // `sessionsRevokedAt`. A missing claim reads as "0", which never matches a
  // real admin's mask, so every machine session would trip that path on first
  // use — 401ing the caller AND signing the impersonated admin out of every
  // other device. Mirrors signInAndMintSession.
  const token = await signSessionJwt(
    {
      id: user.id,
      role: user.role,
      permissions: serializePermissions(user.permissions),
      email: user.email,
      name: user.name,
      provider: "machine",
      mediaServer: user.mediaServer ?? null,
      sessionId,
      uaFingerprint,
      isMobile: false,
      deviceLabel: MACHINE_DEVICE_LABEL,
      expiresAt,
      // Delivered only as Set-Cookie, so it is bound to the cookie transport and
      // refused as a bearer (guardrail 6h).
      transport: "cookie",
      // Bind the mint-time allowlist into the signed claims so the auth guards
      // re-check the caller's IP on every request, not just at mint. A leaked
      // token is then useless from an off-allowlist address. Empty when no
      // allowlist is configured (no per-request IP restriction).
      ...(allowlist.length > 0 ? { machineAllowedIps: allowlist } : {}),
    },
    { expiresInSeconds: expiresIn },
  );
  return { token, sessionId, expiresAt };
}
