import { NextResponse } from "next/server";
import type { Prisma } from "@/generated/prisma";
import { auditContext, logAudit } from "@/lib/audit";
import { withAuth } from "@/lib/api-auth";
import { maintenanceGuard } from "@/lib/maintenance";
import { readJsonCapped } from "@/lib/body-size";
import { normalizeEmail, PLAUSIBLE_EMAIL_RE } from "@/lib/email-normalize";
import { isNotificationEmailEnabled } from "@/lib/email";
import { prisma } from "@/lib/prisma";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { canSetOwnNotificationEmail } from "@/lib/notification-email-verify";
import type { Translator } from "@/lib/i18n/translate";

// The boolean preference columns a PATCH may set. Each must be a User column:
// `data` is typed as Prisma's update input, so a misspelt key fails to compile.
const PREF_KEYS = [
  "notifyOnApproved", "notifyOnAvailable", "notifyOnDeclined",
  "emailOnApproved", "emailOnAvailable", "emailOnDeclined",
  "pushOnApproved", "pushOnAvailable", "pushOnDeclined",
  "notifyOnIssue",
  "notifyOnComment", "emailOnComment", "pushOnComment",
] as const satisfies ReadonlyArray<keyof Prisma.UserUpdateInput>;
type PrefKey = (typeof PREF_KEYS)[number];

// Current notification preferences for the signed-in user. The web settings
// page reads these server-side; native clients need a REST surface.
// `emailEnabled` mirrors the web profile's gate (email feature + "Send
// notification emails" switch + transport configured) so native clients can
// hide their email-preference section while the channel can never send.
export const GET = withAuth(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  const [prefs, emailEnabled] = await Promise.all([
    prisma.user.findUnique({
      where: { id: session.user.id },
      select: {
        notifyOnApproved: true, notifyOnAvailable: true, notifyOnDeclined: true,
        emailOnApproved:  true, emailOnAvailable:  true, emailOnDeclined:  true,
        pushOnApproved:   true, pushOnAvailable:   true, pushOnDeclined:   true,
        notifyOnIssue:    true, notificationEmail: true,
        notifyOnComment:  true, emailOnComment:  true, pushOnComment:  true,
      },
    }),
    isNotificationEmailEnabled(),
  ]);
  if (!prefs) return NextResponse.json({ error: t("apiAuth.common.notFound") }, { status: 404 });
  return NextResponse.json({ ...prefs, emailEnabled });
});

/**
 * The notificationEmail a PATCH may write, or the refusal. Only two values pass:
 *   - null or an empty string clears it;
 *   - the CURRENTLY STORED address, unchanged — a no-op the iOS client's
 *     setNotificationEmail helper sends, since it PATCHes the whole prefs object
 *     back. That value is already verified (it matched Jellyfin when it was set,
 *     or the user confirmed possession through the token flow), and rejecting it
 *     403'd those clients. Equality only — this can never bind a new address.
 * A NEW address is 403: a Jellyfin account has no provider-verified email the
 * way Plex and OIDC do (Jellyfin's API exposes no user email field at all), so
 * accepting one here would let a user redirect Summonarr's outbound mail at ANY
 * mailbox — an email-bombing / harassment vector with the server's own
 * SMTP/Resend reputation behind it. The verification flow (POST
 * /api/profile/notification-email + /confirm) mails a one-time token and binds
 * an address only on proven possession; it is the ONLY way to set a new one.
 */
async function notificationEmailWrite(raw: unknown, userId: string, t: Translator): Promise<{ value: string | null } | NextResponse> {
  if (raw === null || (typeof raw === "string" && raw.trim() === "")) return { value: null };
  if (typeof raw !== "string") {
    return NextResponse.json({ error: t("apiAuth.profile.invalidNotificationEmail") }, { status: 400 });
  }
  if (raw.length > 320 || !PLAUSIBLE_EMAIL_RE.test(raw.trim())) {
    return NextResponse.json({ error: t("apiAuth.common.invalidEmail") }, { status: 400 });
  }
  const candidate = normalizeEmail(raw);
  const me = await prisma.user.findUnique({ where: { id: userId }, select: { notificationEmail: true } });
  if (me?.notificationEmail && candidate === normalizeEmail(me.notificationEmail)) return { value: candidate };
  return NextResponse.json({ error: t("apiAuth.profile.verifyAddressFirst") }, { status: 403 });
}

export const PATCH = withAuth(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  // Personal mutation — blocked during maintenance like push/subscribe and the
  // profile delete/password routes. GET stays open.
  const maint = await maintenanceGuard(session);
  if (maint) return maint;
  const parsed = await readJsonCapped<Partial<Record<PrefKey, unknown>> & { notificationEmail?: unknown }>(req, 16384);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed;

  // Non-boolean values and unknown keys are ignored (the iOS client PATCHes the
  // whole prefs object back).
  const data: Prisma.UserUpdateInput = {};
  for (const key of PREF_KEYS) {
    const v = body[key];
    if (typeof v === "boolean") data[key] = v;
  }

  // notificationEmail is Jellyfin-users-only: Plex and OIDC notificationEmail values are
  // owned by the auth provider and synced on every sign-in in src/lib/auth.ts. Allowing
  // non-Jellyfin users to override here would just be clobbered on their next sign-in.
  if ("notificationEmail" in body) {
    if (!canSetOwnNotificationEmail(session.user.provider)) {
      return NextResponse.json({ error: t("apiAuth.profile.notificationEmailReadOnly") }, { status: 403 });
    }
    const email = await notificationEmailWrite(body.notificationEmail, session.user.id, t);
    if (email instanceof NextResponse) return email;
    data.notificationEmail = email.value;
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: t("apiAuth.profile.noValidFields") }, { status: 400 });
  }

  await prisma.user.update({ where: { id: session.user.id }, data });
  // Clearing the notification address changes where the server's outbound
  // mail goes, so it leaves a trail like the verified bind does (guardrail 26:
  // swallowing variant, after the committed write).
  if ("notificationEmail" in body && data.notificationEmail === null) {
    void logAudit({
      userId: session.user.id,
      userName: session.user.name ?? session.user.email,
      action: "SETTINGS_CHANGE",
      target: `user:${session.user.id}`,
      details: { kind: "notification-email-cleared" },
      ...auditContext(req, session),
    });
  }
  return NextResponse.json({ ok: true });
});
