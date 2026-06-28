import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { hashPassword, MAX_PASSWORD_LENGTH } from "@/lib/password-hash";
import { checkRateLimit, getClientIp, parseRateLimit } from "@/lib/rate-limit";
import { getMaintenanceStatus } from "@/lib/maintenance";
import { sanitizeOptional } from "@/lib/sanitize";
import { normalizeEmail } from "@/lib/auth";
import { defaultPermissionsForRole } from "@/lib/permissions";
import { readJsonCapped } from "@/lib/body-size";
import { parseBearerToken, hasNativeClientHeader, NATIVE_CLIENT_HEADER } from "@/lib/mobile-auth";

// In-process mutex: DB advisory lock is the real guard, but this catches obvious double-submits quickly
let registrationInFlight = false;

export async function POST(req: NextRequest) {
  // CSRF Origin check. A native/bearer client (custom Authorization / X-Summonarr-Client
  // headers a cross-origin page can't forge) carries no ambient-cookie CSRF risk and
  // legitimately sends no browser Origin — exempt it, mirroring the proxy.ts CSRF skip.
  // For everyone else, require a matching Origin: a missing Origin is now REJECTED
  // (previously a blank Origin slipped through), closing the login-CSRF gap.
  const isNativeClient =
    parseBearerToken(req.headers.get("authorization")) !== null ||
    hasNativeClientHeader(req.headers.get(NATIVE_CLIENT_HEADER));
  if (!isNativeClient) {
    const origin = req.headers.get("origin") ?? "";
    // Mirror proxy.ts's trusted-origin set: AUTH_URL plus any comma-separated
    // AUTH_TRUSTED_ORIGIN entries, normalized to bare origins. Reading only
    // AUTH_URL here would 403 a legitimately-configured additional origin that
    // the proxy already trusts.
    const allowed = new Set<string>();
    for (const raw of [process.env.AUTH_URL, ...(process.env.AUTH_TRUSTED_ORIGIN ?? "").split(",")]) {
      const trimmed = raw?.trim();
      if (!trimmed) continue;
      try { allowed.add(new URL(trimmed).origin); } catch { }
    }
    let originOk = false;
    if (origin) {
      try { originOk = allowed.has(new URL(origin).origin); } catch { }
    }
    if (allowed.size === 0 || !originOk) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  const { enabled } = await getMaintenanceStatus();
  if (enabled) {
    return NextResponse.json({ error: "Registration is disabled during maintenance" }, { status: 503 });
  }

  const disableRow = await prisma.setting.findUnique({ where: { key: "disableLocalLogin" } });
  if (disableRow?.value === "true") {
    return NextResponse.json({ error: "Local registration is disabled" }, { status: 403 });
  }

  const rlRow = await prisma.setting.findUnique({ where: { key: "rateLimitRegister" } });
  const limit = parseRateLimit(rlRow?.value, 5);
  if (!checkRateLimit(`register:${getClientIp(req.headers)}`, limit, 15 * 60 * 1000)) {
    return NextResponse.json({ error: "Too many requests — try again later" }, { status: 429 });
  }
  const parsed = await readJsonCapped<{ name?: string; email?: string; password?: string }>(req, 16384);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed;

  const { name, email, password } = body;

  if (!email || !password) {
    return NextResponse.json({ error: "Email and password are required" }, { status: 400 });
  }
  if (typeof password !== "string") {
    // Guard before the .length checks + hashPassword below — a non-string password
    // (e.g. a JSON number) is truthy, so it slips past `!password` and then crashes
    // hashPassword with a TypeError. Mirrors the email typeof check.
    return NextResponse.json({ error: "Invalid password" }, { status: 400 });
  }

  if (typeof email !== "string" || email.length > 254 || /\s/.test(email)) {
    return NextResponse.json({ error: "Invalid email address" }, { status: 400 });
  }
  const emailParts = email.split("@");
  if (emailParts.length !== 2 || !emailParts[0] || !emailParts[1]) {
    return NextResponse.json({ error: "Invalid email address" }, { status: 400 });
  }
  const domainDot = emailParts[1].lastIndexOf(".");
  if (domainDot < 1 || domainDot === emailParts[1].length - 1) {
    return NextResponse.json({ error: "Invalid email address" }, { status: 400 });
  }

  if (name !== undefined && name !== null && (typeof name !== "string" || name.trim().length > 100)) {
    return NextResponse.json({ error: "Name must be under 100 characters" }, { status: 400 });
  }
  const sanitizedName = sanitizeOptional(name);

  if (password.length < 12) {
    return NextResponse.json({ error: "Password must be at least 12 characters" }, { status: 400 });
  }

  if (password.length > MAX_PASSWORD_LENGTH) {
    return NextResponse.json({ error: `Password must be at most ${MAX_PASSWORD_LENGTH} characters` }, { status: 400 });
  }

  const setupRow = await prisma.setting.findUnique({ where: { key: "setup_completed_at" } });
  if (setupRow) {
    return NextResponse.json({ error: "Registration is closed" }, { status: 403 });
  }
  const existingCount = await prisma.user.count();
  if (existingCount > 0) {
    return NextResponse.json({ error: "Registration is closed" }, { status: 403 });
  }

  if (registrationInFlight) {
    return NextResponse.json({ error: "Registration is closed" }, { status: 403 });
  }
  registrationInFlight = true;

  const passwordHash = await hashPassword(password);

  let user: { id: string; email: string; name: string | null; role: string };
  try {
    user = await prisma.$transaction(async (tx) => {
      // Advisory lock 43 ensures only one concurrent initial-registration transaction can succeed
      await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(43)");
      const setupCompleted = await tx.setting.findUnique({ where: { key: "setup_completed_at" } });
      if (setupCompleted) throw new Error("CLOSED");
      const userCount = await tx.user.count();
      if (userCount > 0) {
        throw new Error("CLOSED");
      }
      const created = await tx.user.create({
        data: {
          name: sanitizedName,
          email: normalizeEmail(email),
          passwordHash,
          role: "ADMIN",
          permissions: defaultPermissionsForRole("ADMIN"),
        },
        select: { id: true, email: true, name: true, role: true },
      });
      await tx.setting.create({ data: { key: "setup_completed_at", value: new Date().toISOString() } });
      // Default fresh installs to the safer Discord posture: require a Discord
      // user to have a linked Summonarr account before they can create requests
      // from the guild, rather than letting any guild member request anonymously.
      // This is seeded exactly once, here in the first-admin bootstrap, because an
      // insecure-by-default would let unlinked Discord members file requests on a
      // brand-new instance before the operator has reviewed the setting. Existing
      // installs never re-enter this first-admin block, so their already-saved (or
      // deliberately absent) value is left untouched — only genuinely new installs
      // pick up this default, guaranteeing no behavior change for upgrades.
      // createMany+skipDuplicates makes the seed idempotent: a pre-existing key
      // is silently ignored instead of raising a unique-constraint violation that
      // would abort and roll back this whole registration transaction (guardrail 23).
      await tx.setting.createMany({
        data: [{ key: "discordRequireLinkedAccount", value: "true" }],
        skipDuplicates: true,
      });
      return created;
    });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg === "CLOSED") {
      return NextResponse.json({ error: "Registration is closed" }, { status: 403 });
    }

    if (msg.includes("Unique constraint")) {
      return NextResponse.json({ error: "Registration is closed" }, { status: 403 });
    }
    throw err;
  } finally {
    registrationInFlight = false;
  }

  return NextResponse.json(user, { status: 201 });
}
