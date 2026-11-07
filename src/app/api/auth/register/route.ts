import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { hashPassword } from "@/lib/password-hash";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "@/lib/password-policy";
import { checkRateLimit, getClientIpKey, parseRateLimit } from "@/lib/rate-limit";
import { getMaintenanceStatus } from "@/lib/maintenance";
import { sanitizeOptional } from "@/lib/sanitize";
import { normalizeEmail } from "@/lib/auth";
import { isReservedEmailDomain } from "@/lib/reserved-email";
import { defaultPermissionsForRole } from "@/lib/permissions";
import { readJsonCapped } from "@/lib/body-size";
import { parseBearerToken, hasNativeClientHeader, NATIVE_CLIENT_HEADER } from "@/lib/mobile-auth";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { logAudit, auditContext } from "@/lib/audit";
import { isPrismaErrorCode } from "@/lib/prisma-errors";
import { lockSetupInTx } from "@/lib/setup-lock";
import { configuredTrustedOrigins } from "@/lib/trusted-origin";

// A fixed, DB-free per-IP bound taken before the first Setting read: this is an
// unauthenticated surface, so the limiter must bound anonymous DB load too (the
// setup-status / machine-session / quickconnect pattern). Wider than any sane
// configured register limit; the setting-driven bucket below stays the real cap.
const PRE_LIMIT = 30;
const PRE_WINDOW_MS = 15 * 60 * 1000;

// In-process flag: the DB advisory lock below is the real guard; this just turns away an obvious double-submit early.
let registrationInFlight = false;

export async function POST(req: NextRequest) {
  const t = translatorForRequest(req);
  // CSRF Origin check. A native/bearer client (custom Authorization / X-Summonarr-Client
  // headers a cross-origin page can't forge) carries no ambient-cookie CSRF risk and
  // legitimately sends no browser Origin — exempt it, mirroring the proxy.ts CSRF skip.
  // Everyone else must send a matching Origin; a missing Origin is rejected too,
  // which closes the login-CSRF gap.
  const isNativeClient =
    parseBearerToken(req.headers.get("authorization")) !== null ||
    hasNativeClientHeader(req.headers.get(NATIVE_CLIENT_HEADER));
  if (!isNativeClient) {
    const origin = req.headers.get("origin") ?? "";
    // The proxy's trusted-origin set: AUTH_URL plus any comma-separated
    // AUTH_TRUSTED_ORIGIN entries, read by the shared parser (trusted-origin.ts),
    // so a bare `host:port` entry is skipped rather than trusting the opaque
    // "null" origin. Stricter than the proxy on purpose: an Origin header is
    // required (no Referer fallback) and an empty allowlist trusts nothing.
    const allowed = configuredTrustedOrigins();
    let originOk = false;
    if (origin) {
      try { originOk = allowed.has(new URL(origin).origin); } catch { }
    }
    if (allowed.size === 0 || !originOk) {
      return NextResponse.json({ error: t("apiAuth.common.forbidden") }, { status: 403 });
    }
  }

  if (!checkRateLimit(`register-pre:${getClientIpKey(req.headers)}`, PRE_LIMIT, PRE_WINDOW_MS)) {
    return NextResponse.json({ error: t("apiAuth.common.tooManyRequestsTryLater") }, { status: 429 });
  }

  const { enabled } = await getMaintenanceStatus();
  if (enabled) {
    return NextResponse.json({ error: t("apiAuth.register.maintenance") }, { status: 503 });
  }

  const disableRow = await prisma.setting.findUnique({ where: { key: "disableLocalLogin" } });
  if (disableRow?.value === "true") {
    return NextResponse.json({ error: t("apiAuth.register.localDisabled") }, { status: 403 });
  }

  const rlRow = await prisma.setting.findUnique({ where: { key: "rateLimitRegister" } });
  const limit = parseRateLimit(rlRow?.value, 5);
  if (!checkRateLimit(`register:${getClientIpKey(req.headers)}`, limit, 15 * 60 * 1000)) {
    return NextResponse.json({ error: t("apiAuth.common.tooManyRequestsTryLater") }, { status: 429 });
  }
  const parsed = await readJsonCapped<{ name?: string; email?: string; password?: string }>(req, 16384);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed;

  const { name, email, password } = body;

  if (!email || !password) {
    return NextResponse.json({ error: t("apiAuth.register.credentialsRequired") }, { status: 400 });
  }
  if (typeof password !== "string") {
    // Guard before the .length checks + hashPassword below — a non-string password
    // (e.g. a JSON number) is truthy, so it slips past `!password` and then crashes
    // hashPassword with a TypeError. Mirrors the email typeof check.
    return NextResponse.json({ error: t("apiAuth.common.invalidPassword") }, { status: 400 });
  }

  // Normalize FIRST, then validate the normalized value: NFKC folds a fullwidth
  // "＠" (neither whitespace nor "@") into a real "@", so validating the raw
  // string let `a＠b@c.com` pass the single-@ rule and be stored as `a@b@c.com`.
  // Whitespace is still refused on the RAW value (padding is rejected, not trimmed).
  if (typeof email !== "string" || email.length > 254 || /\s/.test(email)) {
    return NextResponse.json({ error: t("apiAuth.common.invalidEmail") }, { status: 400 });
  }
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail || normalizedEmail.length > 254 || /\s/.test(normalizedEmail)) {
    return NextResponse.json({ error: t("apiAuth.common.invalidEmail") }, { status: 400 });
  }
  const emailParts = normalizedEmail.split("@");
  if (emailParts.length !== 2 || !emailParts[0] || !emailParts[1]) {
    return NextResponse.json({ error: t("apiAuth.common.invalidEmail") }, { status: 400 });
  }
  const domainDot = emailParts[1].lastIndexOf(".");
  if (domainDot < 1 || domainDot === emailParts[1].length - 1) {
    return NextResponse.json({ error: t("apiAuth.common.invalidEmail") }, { status: 400 });
  }
  // Summonarr mints addresses in these domains for itself (reserved-email.ts,
  // guardrail 34e); a human account must never hold one.
  if (isReservedEmailDomain(normalizedEmail)) {
    return NextResponse.json({ error: t("apiAuth.common.reservedEmail") }, { status: 400 });
  }

  if (name !== undefined && name !== null && (typeof name !== "string" || name.trim().length > 100)) {
    return NextResponse.json({ error: t("apiAuth.register.nameTooLong") }, { status: 400 });
  }
  const sanitizedName = sanitizeOptional(name);

  if (password.length < MIN_PASSWORD_LENGTH) {
    return NextResponse.json({ error: t("apiAuth.register.passwordTooShort") }, { status: 400 });
  }

  if (password.length > MAX_PASSWORD_LENGTH) {
    return NextResponse.json({ error: t("apiAuth.register.passwordTooLong", { max: MAX_PASSWORD_LENGTH }) }, { status: 400 });
  }

  const setupRow = await prisma.setting.findUnique({ where: { key: "setup_completed_at" } });
  if (setupRow) {
    return NextResponse.json({ error: t("apiAuth.register.closed") }, { status: 403 });
  }
  const existingCount = await prisma.user.count();
  if (existingCount > 0) {
    return NextResponse.json({ error: t("apiAuth.register.closed") }, { status: 403 });
  }

  if (registrationInFlight) {
    return NextResponse.json({ error: t("apiAuth.register.closed") }, { status: 403 });
  }
  registrationInFlight = true;

  let user: { id: string; email: string; name: string | null; role: string };
  // hashPassword must stay INSIDE the try. If it threw outside it, the finally
  // would never reset registrationInFlight, and every later attempt would get
  // "Registration is closed" until the process restarted — so the first admin
  // could never be created.
  try {
    const passwordHash = await hashPassword(password);
    user = await prisma.$transaction(async (tx) => {
      // Advisory lock 43 (setup-lock.ts) ensures only one concurrent initial-registration
      // transaction can succeed, and serializes it with the first-run restore.
      await lockSetupInTx(tx);
      const setupCompleted = await tx.setting.findUnique({ where: { key: "setup_completed_at" } });
      if (setupCompleted) throw new Error("CLOSED");
      const userCount = await tx.user.count();
      if (userCount > 0) {
        throw new Error("CLOSED");
      }
      const created = await tx.user.create({
        data: {
          name: sanitizedName,
          email: normalizedEmail,
          passwordHash,
          role: "ADMIN",
          permissions: defaultPermissionsForRole("ADMIN"),
        },
        select: { id: true, email: true, name: true, role: true },
      });
      await tx.setting.create({ data: { key: "setup_completed_at", value: new Date().toISOString() } });
      // Default fresh installs to the safer Discord posture: require a linked
      // Summonarr account before a guild member can request, rather than allowing
      // anonymous requests. Seeded once in the first-admin bootstrap so a brand-new
      // instance is secure before the operator reviews the setting; existing installs
      // never re-enter this block, so upgrades are untouched.
      // createMany+skipDuplicates keeps the seed idempotent — a pre-existing key is
      // ignored rather than aborting this registration transaction (guardrail 23).
      await tx.setting.createMany({
        data: [{ key: "discordRequireLinkedAccount", value: "true" }],
        skipDuplicates: true,
      });
      return created;
    });
  } catch (err) {
    // `err` may not be an Error (anything can be thrown); fall back to "".
    const msg = err instanceof Error ? err.message : "";
    if (msg === "CLOSED") {
      return NextResponse.json({ error: t("apiAuth.register.closed") }, { status: 403 });
    }

    // A racing first registration that slipped past the lock's checks lands on
    // the unique email / setup key. Read the code, never the message text, and
    // never `instanceof` (guardrail 23b).
    if (isPrismaErrorCode(err, "P2002")) {
      return NextResponse.json({ error: t("apiAuth.register.closed") }, { status: 403 });
    }
    throw err;
  } finally {
    registrationInFlight = false;
  }

  // The instance's first ADMIN was just created by an unauthenticated request —
  // the one moment anyone who reaches the setup page can take the server. The
  // row records who did it and from where. Post-commit and swallowing
  // (guardrail 26): the account exists either way. Named by id, not email.
  void logAudit({
    userId: user.id,
    userName: user.name ?? user.email,
    action: "USER_CREATE",
    target: `user:${user.id}`,
    details: { kind: "first-admin", targetUserId: user.id, role: user.role },
    ...auditContext(req),
    provider: "credentials",
  });

  return NextResponse.json(user, { status: 201 });
}
