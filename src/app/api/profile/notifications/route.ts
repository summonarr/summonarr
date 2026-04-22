import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { normalizeEmail } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// RFC-5322-lite: local@domain, at least one dot in the domain, no whitespace.
// Intentionally loose — SMTP will reject anything the regex lets through.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function PATCH(req: NextRequest) {
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;

  let body: {
    notifyOnApproved?: boolean; notifyOnAvailable?: boolean; notifyOnDeclined?: boolean;
    emailOnApproved?: boolean;  emailOnAvailable?: boolean;  emailOnDeclined?: boolean;
    pushOnApproved?: boolean;   pushOnAvailable?: boolean;   pushOnDeclined?: boolean;
    notifyOnIssue?: boolean;
    notificationEmail?: string | null;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const data: Record<string, boolean | string | null> = {};
  if (typeof body.notifyOnApproved === "boolean") data.notifyOnApproved = body.notifyOnApproved;
  if (typeof body.notifyOnAvailable === "boolean") data.notifyOnAvailable = body.notifyOnAvailable;
  if (typeof body.notifyOnDeclined === "boolean") data.notifyOnDeclined = body.notifyOnDeclined;
  if (typeof body.emailOnApproved === "boolean")  data.emailOnApproved  = body.emailOnApproved;
  if (typeof body.emailOnAvailable === "boolean") data.emailOnAvailable = body.emailOnAvailable;
  if (typeof body.emailOnDeclined === "boolean")  data.emailOnDeclined  = body.emailOnDeclined;
  if (typeof body.pushOnApproved === "boolean")   data.pushOnApproved   = body.pushOnApproved;
  if (typeof body.pushOnAvailable === "boolean")  data.pushOnAvailable  = body.pushOnAvailable;
  if (typeof body.pushOnDeclined === "boolean")   data.pushOnDeclined   = body.pushOnDeclined;
  if (typeof body.notifyOnIssue === "boolean")    data.notifyOnIssue    = body.notifyOnIssue;

  // notificationEmail is Jellyfin-users-only: Plex and OIDC notificationEmail values are
  // owned by the auth provider and synced on every sign-in in src/lib/auth.ts. Allowing
  // non-Jellyfin users to override here would just be clobbered on their next sign-in.
  if ("notificationEmail" in body) {
    const provider = session.user.provider;
    const isJellyfin = provider === "jellyfin" || provider === "jellyfin-quickconnect";
    if (!isJellyfin) {
      return NextResponse.json({ error: "notificationEmail is read-only for this sign-in method" }, { status: 403 });
    }

    const raw = body.notificationEmail;
    if (raw === null || (typeof raw === "string" && raw.trim() === "")) {
      data.notificationEmail = null;
    } else if (typeof raw === "string") {
      if (raw.length > 320 || !EMAIL_RE.test(raw.trim())) {
        return NextResponse.json({ error: "Invalid email address" }, { status: 400 });
      }
      data.notificationEmail = normalizeEmail(raw);
    } else {
      return NextResponse.json({ error: "Invalid notificationEmail" }, { status: 400 });
    }
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "No valid fields provided" }, { status: 400 });
  }

  await prisma.user.update({ where: { id: session.user.id }, data });
  return NextResponse.json({ ok: true });
}
