import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import bcrypt from "bcryptjs";
import { checkRateLimit, getClientIp, parseRateLimit } from "@/lib/rate-limit";
import { getMaintenanceStatus } from "@/lib/maintenance";
import { sanitizeOptional } from "@/lib/sanitize";
import { normalizeEmail } from "@/lib/auth";

// In-process mutex: DB advisory lock is the real guard, but this catches obvious double-submits quickly
let registrationInFlight = false;

export async function POST(req: NextRequest) {
  const origin = req.headers.get("origin") ?? "";
  const allowedOrigin = (process.env.AUTH_URL ?? process.env.NEXTAUTH_URL ?? "").replace(/\/$/, "");
  if (origin && allowedOrigin && origin !== allowedOrigin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
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
  let body: { name?: string; email?: string; password?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { name, email, password } = body;

  if (!email || !password) {
    return NextResponse.json({ error: "Email and password are required" }, { status: 400 });
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

  if (password.length < 8) {
    return NextResponse.json({ error: "Password must be at least 8 characters" }, { status: 400 });
  }

  if (password.length > 1024) {
    return NextResponse.json({ error: "Password must be at most 1024 characters" }, { status: 400 });
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

  const passwordHash = await bcrypt.hash(password, 12);

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
        },
        select: { id: true, email: true, name: true, role: true },
      });
      await tx.setting.create({ data: { key: "setup_completed_at", value: new Date().toISOString() } });
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
