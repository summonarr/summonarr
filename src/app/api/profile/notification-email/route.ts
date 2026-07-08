import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { readJsonCapped } from "@/lib/body-size";
import { prisma } from "@/lib/prisma";
import { normalizeEmail } from "@/lib/auth";
import { checkRateLimit } from "@/lib/rate-limit";
import { isNotificationEmailEnabled, sendNotificationEmailVerification } from "@/lib/email";
import { tooManyRequests } from "@/lib/http";
import {
  generateVerifyToken,
  buildVerifyIdentifier,
  verifyIdentifierPrefixFor,
  VERIFY_TTL_MS,
} from "@/lib/notification-email-verify";

// RFC-5322-lite (matches the profile route). SMTP rejects the rest.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// POST { email } — begin verifying a self-service notification email for a
// Jellyfin user. A one-time link is mailed to the CANDIDATE address; the address
// is bound to the account only once that link is confirmed (proof of possession),
// which is what stops this from being a "redirect Summonarr's mail at a victim"
// vector. Jellyfin-only (Plex/OIDC emails are provider-owned + synced on sign-in).
export const POST = withAuth(async (req, _ctx, session) => {
  const provider = session.user.provider;
  const isJellyfin = provider === "jellyfin" || provider === "jellyfin-quickconnect";
  if (!isJellyfin) {
    return NextResponse.json({ error: "notificationEmail is read-only for this sign-in method" }, { status: 403 });
  }

  // 3 sends / 15 min per user — an authenticated user can't weaponize this into
  // an email-bombing tool against an arbitrary mailbox.
  if (!checkRateLimit(`notif-email-verify:${session.user.id}`, 3, 15 * 60_000)) {
    return tooManyRequests(900, "Too many verification emails — try again later.");
  }

  const parsed = await readJsonCapped<{ email?: string }>(req, 16384);
  if (parsed instanceof NextResponse) return parsed;
  const rawEmail = typeof parsed.email === "string" ? parsed.email.trim() : "";
  if (!rawEmail || rawEmail.length > 320 || !EMAIL_RE.test(rawEmail)) {
    return NextResponse.json({ error: "Invalid email address" }, { status: 400 });
  }

  if (!(await isNotificationEmailEnabled())) {
    return NextResponse.json({ error: "Email notifications aren't configured on this server." }, { status: 400 });
  }

  const email = normalizeEmail(rawEmail);
  const { raw: token, hash } = generateVerifyToken();

  // One pending verification per user: clear any prior, then store the new hash.
  await prisma.verificationToken.deleteMany({
    where: { identifier: { startsWith: verifyIdentifierPrefixFor(session.user.id) } },
  });
  await prisma.verificationToken.create({
    data: {
      identifier: buildVerifyIdentifier(session.user.id, email),
      token: hash,
      expires: new Date(Date.now() + VERIFY_TTL_MS),
    },
  });

  try {
    await sendNotificationEmailVerification(email, token);
  } catch (err) {
    console.error("[notif-email] verification send failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Couldn't send the verification email — contact the server owner." }, { status: 502 });
  }

  return NextResponse.json({ ok: true, email });
});
