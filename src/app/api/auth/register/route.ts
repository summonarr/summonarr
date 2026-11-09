import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { hashPassword } from "@/lib/password-hash";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "@/lib/password-policy";
import { checkRateLimit, getClientIpKey, parseRateLimit } from "@/lib/rate-limit";
import { getMaintenanceStatus } from "@/lib/maintenance";
import { sanitizeOptional } from "@/lib/sanitize";
import { parseAccountEmail } from "@/lib/account-email";
import { isReservedEmailDomain } from "@/lib/reserved-email";
import { defaultPermissionsForRole } from "@/lib/permissions";
import { readJsonCapped } from "@/lib/body-size";
import { parseBearerToken, hasNativeClientHeader, NATIVE_CLIENT_HEADER } from "@/lib/mobile-auth";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import type { Translator } from "@/lib/i18n/translate";
import { logAudit, auditContext } from "@/lib/audit";
import { isPrismaErrorCode } from "@/lib/prisma-errors";
import { lockSetupInTx, registrationClosed } from "@/lib/setup-lock";
import { configuredTrustedOrigins } from "@/lib/trusted-origin";

// A fixed, DB-free per-IP bound taken before the first Setting read: this is an
// unauthenticated surface, so the limiter must bound anonymous DB load too (the
// setup-status / machine-session / quickconnect pattern). Wider than any sane
// configured register limit; the setting-driven bucket below stays the real cap.
const PRE_LIMIT = 30;
const PRE_WINDOW_MS = 15 * 60 * 1000;

type CreatedUser = { id: string; email: string; name: string | null; role: string };

export async function POST(req: NextRequest) {
  const t = translatorForRequest(req);
  if (!originAllowed(req)) {
    return NextResponse.json({ error: t("apiAuth.common.forbidden") }, { status: 403 });
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
  const input = validateRegistration(parsed, t);
  if (input instanceof NextResponse) return input;

  // A cheap read before the scrypt hash below: once setup is done every
  // anonymous attempt is refused here without spending a 128 MiB derivation.
  // The locked re-check in createFirstAdmin is what decides.
  if (await registrationClosed(prisma)) {
    return NextResponse.json({ error: t("apiAuth.register.closed") }, { status: 403 });
  }

  let user: CreatedUser | null;
  try {
    user = await createFirstAdmin(input);
  } catch (err) {
    // A racing first registration that slipped past the lock's checks lands on
    // the unique email / setup key. Read the code, never the message text, and
    // never `instanceof` (guardrail 23b).
    if (isPrismaErrorCode(err, "P2002")) {
      return NextResponse.json({ error: t("apiAuth.register.closed") }, { status: 403 });
    }
    throw err;
  }
  if (!user) {
    return NextResponse.json({ error: t("apiAuth.register.closed") }, { status: 403 });
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

// CSRF Origin check. A native/bearer client (custom Authorization / X-Summonarr-Client
// headers a cross-origin page can't forge) carries no ambient-cookie CSRF risk and
// legitimately sends no browser Origin — exempt it, mirroring the proxy.ts CSRF skip.
// Everyone else must send a matching Origin; a missing Origin is rejected too,
// which closes the login-CSRF gap.
function originAllowed(req: NextRequest): boolean {
  const isNativeClient =
    parseBearerToken(req.headers.get("authorization")) !== null ||
    hasNativeClientHeader(req.headers.get(NATIVE_CLIENT_HEADER));
  if (isNativeClient) return true;
  const origin = req.headers.get("origin") ?? "";
  // The proxy's trusted-origin set: AUTH_URL plus any comma-separated
  // AUTH_TRUSTED_ORIGIN entries, read by the shared parser (trusted-origin.ts),
  // so a bare `host:port` entry is skipped rather than trusting the opaque
  // "null" origin. Stricter than the proxy on purpose: an Origin header is
  // required (no Referer fallback) and an empty allowlist trusts nothing.
  const allowed = configuredTrustedOrigins();
  if (allowed.size === 0 || !origin) return false;
  try {
    return allowed.has(new URL(origin).origin);
  } catch {
    return false;
  }
}

// The body, judged before any account exists: email, password and name, in
// that order of refusal.
function validateRegistration(
  body: { name?: unknown; email?: unknown; password?: unknown },
  t: Translator,
): { email: string; password: string; name: string | null } | NextResponse {
  const refuse = (key: string, vars?: Record<string, string | number>) =>
    NextResponse.json({ error: t(key, vars) }, { status: 400 });
  const { name, email, password } = body;
  if (!email || !password) return refuse("apiAuth.register.credentialsRequired");
  // Guard before the .length checks + hashPassword — a non-string password
  // (e.g. a JSON number) is truthy, so it slips past `!password` and then crashes
  // hashPassword with a TypeError.
  if (typeof password !== "string") return refuse("apiAuth.common.invalidPassword");

  const normalizedEmail = parseAccountEmail(email);
  if (normalizedEmail === null) return refuse("apiAuth.common.invalidEmail");
  // Summonarr mints addresses in these domains for itself (reserved-email.ts,
  // guardrail 34e); a human account must never hold one.
  if (isReservedEmailDomain(normalizedEmail)) return refuse("apiAuth.common.reservedEmail");

  if (name !== undefined && name !== null && (typeof name !== "string" || name.trim().length > 100)) {
    return refuse("apiAuth.register.nameTooLong");
  }
  if (password.length < MIN_PASSWORD_LENGTH) return refuse("apiAuth.register.passwordTooShort");
  if (password.length > MAX_PASSWORD_LENGTH) return refuse("apiAuth.register.passwordTooLong", { max: MAX_PASSWORD_LENGTH });
  return { email: normalizedEmail, password, name: sanitizeOptional(typeof name === "string" ? name : null) };
}

// The first ADMIN, or null when registration closed meanwhile. Advisory lock
// 43 (setup-lock.ts) lets only one concurrent initial registration succeed and
// serializes it with the first-run restore; the closed check under the lock is
// the one that decides.
async function createFirstAdmin(input: { email: string; password: string; name: string | null }): Promise<CreatedUser | null> {
  const passwordHash = await hashPassword(input.password);
  return prisma.$transaction(async (tx) => {
    await lockSetupInTx(tx);
    if (await registrationClosed(tx)) return null;
    const created = await tx.user.create({
      data: {
        name: input.name,
        email: input.email,
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
}
