import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { maintenanceGuard } from "@/lib/maintenance";
import { readJsonCapped } from "@/lib/body-size";
import { prisma } from "@/lib/prisma";
import { normalizeEmail } from "@/lib/auth";
import { checkRateLimit, peekRateLimit } from "@/lib/rate-limit";
import { isNotificationEmailEnabled, sendNotificationEmailVerification } from "@/lib/email";
import { localeForRequest } from "@/lib/i18n/server-locale";
import { tooManyRequests } from "@/lib/http";
import { isNativeSessionForStepUp, requireStepUp } from "@/lib/step-up-auth";
import {
  generateVerifyToken,
  buildVerifyIdentifier,
  verifyIdentifierPrefixFor,
  VERIFY_TTL_MS,
} from "@/lib/notification-email-verify";
import { translatorForRequest } from "@/lib/i18n/server-locale";

// RFC-5322-lite (matches the profile route). SMTP rejects the rest.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// POST { email, confirmPassword? } — begin verifying a self-service notification
// email for a Jellyfin user. A one-time link is mailed to the CANDIDATE address; the address
// is bound to the account only once that link is confirmed (proof of possession),
// which is what stops this from being a "redirect Summonarr's mail at a victim"
// vector. Jellyfin-only (Plex/OIDC emails are provider-owned + synced on sign-in).
export const POST = withAuth(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  // Fires outbound mail — blocked during maintenance like push/subscribe.
  const maint = await maintenanceGuard(session);
  if (maint) return maint;
  const provider = session.user.provider;
  const isJellyfin = provider === "jellyfin" || provider === "jellyfin-quickconnect";
  if (!isJellyfin) {
    return NextResponse.json({ error: t("apiAuth.profile.notificationEmailReadOnly") }, { status: 403 });
  }

  const parsed = await readJsonCapped<{ email?: string; confirmPassword?: unknown }>(req, 16384);
  if (parsed instanceof NextResponse) return parsed;

  // 3 sends / 15 min per user — an authenticated user can't weaponize this into
  // an email-bombing tool against an arbitrary mailbox. PEEKED before the
  // step-up, so a spent budget refuses without a password verify: a correct
  // step-up password refunds its own hit, so nothing else stops a loop of them,
  // each a full scrypt in the 2-slot hash queue (guardrail 6i). Spent only once
  // the step-up passes, below.
  const sendKey = `notif-email-verify:${session.user.id}`;
  if (!peekRateLimit(sendKey, 3, 15 * 60_000)) {
    return tooManyRequests(900, t("apiAuth.profile.tooManyVerificationEmails"));
  }

  // Step-up (guardrail 6g): a confirmed address receives every notification and
  // security email from then on, and outlives a password change or sign out
  // everywhere, so a hijacked session must not be able to point it at the
  // hijacker's own mailbox. Ahead of spending a send, so the password prompt's
  // first round trip doesn't use one up. A native session is exempt, as on the
  // other 6g routes: the shipped iOS app calls this route and has no prompt.
  if (!(await isNativeSessionForStepUp(session, req))) {
    const denied = await requireStepUp({
      req,
      session,
      confirmPassword: parsed.confirmPassword,
      context: "notification-email",
      messages: {
        passwordRequired: t("apiAuth.stepUp.passwordRequired"),
        recentSignInRequired: t("apiAuth.stepUp.recentSignIn"),
      },
      t,
    });
    if (denied) return denied;
  }

  if (!checkRateLimit(sendKey, 3, 15 * 60_000)) {
    return tooManyRequests(900, t("apiAuth.profile.tooManyVerificationEmails"));
  }

  const rawEmail = typeof parsed.email === "string" ? parsed.email.trim() : "";
  if (!rawEmail || rawEmail.length > 320 || !EMAIL_RE.test(rawEmail)) {
    return NextResponse.json({ error: t("apiAuth.common.invalidEmail") }, { status: 400 });
  }

  if (!(await isNotificationEmailEnabled())) {
    return NextResponse.json({ error: t("apiAuth.profile.emailNotConfigured") }, { status: 400 });
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
    // Written in the requesting user's language (they are the recipient).
    await sendNotificationEmailVerification(email, token, localeForRequest(req));
  } catch (err) {
    console.error("[notif-email] verification send failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: t("apiAuth.profile.verificationSendFailed") }, { status: 502 });
  }

  return NextResponse.json({ ok: true, email });
});
