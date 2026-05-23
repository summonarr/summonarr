import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";

// Public endpoint by design — the pre-login setup screen needs to know whether
// any user exists before showing the registration vs sign-in flow. But the raw
// `prisma.user.count()` exposes a boolean to anonymous callers, so cap the
// per-IP request rate to keep it from being abused as a fingerprinting probe
// or as a way to monitor when an admin account is first provisioned.
export async function GET(req: NextRequest) {
  if (!checkRateLimit(`setup-status:${getClientIp(req.headers)}`, 30, 60_000)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }
  const count = await prisma.user.count();
  return NextResponse.json({ needsSetup: count === 0 });
}
