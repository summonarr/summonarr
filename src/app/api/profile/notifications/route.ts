import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { readJsonCapped } from "@/lib/body-size";
import { normalizeEmail } from "@/lib/auth";
import { isNotificationEmailEnabled } from "@/lib/email";
import { getJellyfinUserEmail } from "@/lib/jellyfin";
import { getJellyfinConfig } from "@/lib/jellyfin-config";
import { prisma } from "@/lib/prisma";

// RFC-5322-lite: local@domain, at least one dot in the domain, no whitespace.
// Intentionally loose — SMTP will reject anything the regex lets through.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Current notification preferences for the signed-in user. The web settings
// page reads these server-side; native clients need a REST surface.
// `emailEnabled` mirrors the web profile's gate (email feature + "Send
// notification emails" switch + transport configured) so native clients can
// hide their email-preference section while the channel can never send.
export const GET = withAuth(async (_req, _ctx, session) => {
  const [prefs, emailEnabled] = await Promise.all([
    prisma.user.findUnique({
      where: { id: session.user.id },
      select: {
        notifyOnApproved: true, notifyOnAvailable: true, notifyOnDeclined: true,
        emailOnApproved:  true, emailOnAvailable:  true, emailOnDeclined:  true,
        pushOnApproved:   true, pushOnAvailable:   true, pushOnDeclined:   true,
        notifyOnIssue:    true, notificationEmail: true,
      },
    }),
    isNotificationEmailEnabled(),
  ]);
  if (!prefs) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ ...prefs, emailEnabled });
});

export const PATCH = withAuth(async (req, _ctx, session) => {
  const parsed = await readJsonCapped<{
    notifyOnApproved?: boolean; notifyOnAvailable?: boolean; notifyOnDeclined?: boolean;
    emailOnApproved?: boolean;  emailOnAvailable?: boolean;  emailOnDeclined?: boolean;
    pushOnApproved?: boolean;   pushOnAvailable?: boolean;   pushOnDeclined?: boolean;
    notifyOnIssue?: boolean;
    notificationEmail?: string | null;
  }>(req, 16384);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed;

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
      // A Jellyfin-authenticated user has no provider-verified email the way Plex
      // and OIDC users do (those addresses are owned and synced by the IdP on every
      // sign-in). If we accepted an arbitrary notificationEmail here, a user could
      // redirect Summonarr's outbound mail (approved / available / declined / issue
      // notifications) to ANY address — including a victim's mailbox — turning the
      // notification system into an email-bombing / harassment vector with the
      // server's own SMTP/Resend reputation behind it.
      //
      // Mitigation: bind the value to the address THIS Jellyfin server reports for
      // the account (fetched live below). An attacker cannot point notifications at
      // a mailbox they don't already control on the upstream Jellyfin server, so the
      // upstream server's own account ownership becomes the verification boundary.
      // Summonarr has no self-service email-verification flow (no confirmation-code
      // round-trip), so this server-authoritative match is the only sound mitigation
      // available.
      const candidate = normalizeEmail(raw);
      const me = await prisma.user.findUnique({
        where: { id: session.user.id },
        select: { jellyfinUserId: true },
      });
      const jellyfinUserId = me?.jellyfinUserId ?? null;

      let reportedEmail: string | null = null;
      if (jellyfinUserId) {
        const { url, apiKey } = await getJellyfinConfig();
        if (url && apiKey) {
          // getJellyfinUserEmail routes through safeFetchAdminConfigured and only
          // reads Settings (no encryptToken at the call site — guardrail 7a holds).
          const fromJellyfin = await getJellyfinUserEmail(url, apiKey, jellyfinUserId);
          if (fromJellyfin) reportedEmail = normalizeEmail(fromJellyfin);
        }
      }

      // TODO: If the Jellyfin server reports NO email for this account there is
      // nothing server-authoritative to bind the requested address to. Rather than
      // fall back to accepting an unverified free-form address (which would reopen
      // the notification-redirect / harassment vector described above), reject the
      // write. The proper long-term fix is a self-service email-verification flow
      // (mail a one-time code to the requested address and persist it only after the
      // user confirms possession) — deferred because it requires reliable outbound
      // mail infrastructure to be a hard dependency of the profile flow.
      if (!reportedEmail) {
        return NextResponse.json(
          { error: "Set an email on your Jellyfin account first, then it can be used for notifications." },
          { status: 403 },
        );
      }
      if (candidate !== reportedEmail) {
        return NextResponse.json(
          { error: "notificationEmail must match the email on your Jellyfin account." },
          { status: 403 },
        );
      }
      data.notificationEmail = candidate;
    } else {
      return NextResponse.json({ error: "Invalid notificationEmail" }, { status: 400 });
    }
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "No valid fields provided" }, { status: 400 });
  }

  await prisma.user.update({ where: { id: session.user.id }, data });
  return NextResponse.json({ ok: true });
});
