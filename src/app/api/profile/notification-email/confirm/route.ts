import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { logAudit, auditContext } from "@/lib/audit";
import { hashVerifyToken, parseVerifyIdentifier } from "@/lib/notification-email-verify";
import { localeForRequest, translatorFor } from "@/lib/i18n/server-locale";
import type { Locale } from "@/lib/i18n/locales";

// PUBLIC (listed in isPublicPath in proxy.ts + ROUTE_EXCEPTIONS in
// audit-routes.mts): the one-time token in the query IS the credential. The link
// was mailed to the candidate address, so possession proves it. Single-use +
// short-lived.
//
// The bind happens ONLY in POST, driven by a human clicking a form button. GET
// merely renders that form. This closes the mail-gateway-prefetcher hole:
// SafeLinks/Mimecast/Proofpoint (and Next mapping HEAD→GET) fetch the link at
// delivery time with GET/HEAD and never submit a form, so an automated preview
// can no longer auto-confirm — and thus can't bind a victim's address to an
// attacker's account without a real click.
export const dynamic = "force-dynamic";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const pageHead = (locale: Locale) => `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`;
const BODY_OPEN = `<body style="font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;background:#09090b;color:#e4e4e7;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center">
<div style="max-width:420px;margin:16px;padding:28px;text-align:center;border:1px solid #27272a;border-radius:12px;background:#18181b">`;

function resultPage(locale: Locale, title: string, message: string, ok: boolean): NextResponse {
  const html = `${pageHead(locale)}<title>${escapeHtml(title)}</title></head>
${BODY_OPEN}
<div style="font-size:34px;line-height:1;margin-bottom:12px">${ok ? "✓" : "⚠"}</div>
<h1 style="font-size:18px;font-weight:600;margin:0 0 8px">${escapeHtml(title)}</h1>
<p style="font-size:13px;color:#a1a1aa;line-height:1.55;margin:0">${escapeHtml(message)}</p>
</div></body></html>`;
  return new NextResponse(html, {
    status: ok ? 200 : 400,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

// GET: render the confirmation form. It reads (but never consumes/binds) the
// token so it can show the pending address. The form re-POSTs the token in its
// action URL — a deliberate human click is what performs the bind.
export async function GET(req: Request) {
  const locale = localeForRequest(req);
  const t = translatorFor(locale);
  const token = new URL(req.url).searchParams.get("token");
  if (!token) {
    return resultPage(locale, t("apiAuth.emailConfirm.invalidLinkTitle"), t("apiAuth.emailConfirm.missingToken"), false);
  }

  const row = await prisma.verificationToken.findUnique({ where: { token: hashVerifyToken(token) } });
  if (!row) {
    return resultPage(locale, t("apiAuth.emailConfirm.usedTitle"), t("apiAuth.emailConfirm.usedBody"), false);
  }

  if (row.expires.getTime() < Date.now()) {
    return resultPage(locale, t("apiAuth.emailConfirm.expiredTitle"), t("apiAuth.emailConfirm.expiredBody"), false);
  }

  const parsed = parseVerifyIdentifier(row.identifier);
  if (!parsed) {
    return resultPage(locale, t("apiAuth.emailConfirm.invalidLinkTitle"), t("apiAuth.emailConfirm.malformed"), false);
  }

  // The token is opaque hex, but escape into the action URL defensively; the
  // email is reflected as text content and MUST be HTML-escaped.
  //
  // BASE_PATH: a root-absolute action posts to the ORIGIN root, so on a subpath
  // deployment (BASE_PATH=/request) the Confirm button 404s and the address can
  // never be verified. Prefix it the same way proxy.ts builds its redirects.
  // No-op when BASE_PATH is unset (the default).
  const basePath = process.env.BASE_PATH ?? "";
  const action = `${basePath}/api/profile/notification-email/confirm?token=${encodeURIComponent(token)}`;
  // The address is spliced in AFTER escaping the translated sentence, so the
  // <strong> markup survives while the surrounding text stays escaped.
  const EMAIL_SLOT = "%%EMAIL%%";
  const bindLine = escapeHtml(t("apiAuth.emailConfirm.body", { email: EMAIL_SLOT })).replace(
    EMAIL_SLOT,
    // A function replacer: a string one would expand $-patterns in the address.
    () => `<strong style="color:#e4e4e7">${escapeHtml(parsed.email)}</strong>`,
  );
  const html = `${pageHead(locale)}<title>${escapeHtml(t("apiAuth.emailConfirm.pageTitle"))}</title></head>
${BODY_OPEN}
<div style="font-size:34px;line-height:1;margin-bottom:12px">✉</div>
<h1 style="font-size:18px;font-weight:600;margin:0 0 8px">${escapeHtml(t("apiAuth.emailConfirm.heading"))}</h1>
<p style="font-size:13px;color:#a1a1aa;line-height:1.55;margin:0 0 12px">${bindLine}</p>
<p style="font-size:13px;color:#a1a1aa;line-height:1.55;margin:0 0 20px">${escapeHtml(t("apiAuth.emailConfirm.notYou"))}</p>
<form method="post" action="${escapeHtml(action)}">
<button type="submit" style="display:inline-block;width:100%;padding:11px 16px;font-size:14px;font-weight:600;color:#09090b;background:#e4e4e7;border:none;border-radius:8px;cursor:pointer">${escapeHtml(t("apiAuth.emailConfirm.button"))}</button>
</form>
</div></body></html>`;
  return new NextResponse(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

// POST: the actual bind. Only a human form submission reaches here.
export async function POST(req: Request) {
  const locale = localeForRequest(req);
  const t = translatorFor(locale);
  const token = new URL(req.url).searchParams.get("token");
  if (!token) {
    return resultPage(locale, t("apiAuth.emailConfirm.invalidLinkTitle"), t("apiAuth.emailConfirm.missingToken"), false);
  }

  const row = await prisma.verificationToken.findUnique({ where: { token: hashVerifyToken(token) } });
  if (!row) {
    return resultPage(locale, t("apiAuth.emailConfirm.usedTitle"), t("apiAuth.emailConfirm.usedBody"), false);
  }

  // Single-use: consume the token FIRST so a double-submit can't re-trigger the bind.
  await prisma.verificationToken.delete({ where: { token: row.token } }).catch(() => {});

  if (row.expires.getTime() < Date.now()) {
    return resultPage(locale, t("apiAuth.emailConfirm.expiredTitle"), t("apiAuth.emailConfirm.expiredBody"), false);
  }

  const parsed = parseVerifyIdentifier(row.identifier);
  if (!parsed) {
    return resultPage(locale, t("apiAuth.emailConfirm.invalidLinkTitle"), t("apiAuth.emailConfirm.malformed"), false);
  }

  try {
    // updateMany (not update): a since-deleted account no-ops instead of throwing;
    // the email value is never reflected into the HTML (avoids any injection).
    // Scoped to a still-active, never-purged row: a link clicked after the account
    // was disabled or purged must not write a personal address back onto it
    // (guardrail 33 — a purge's scrub would otherwise be partly undone).
    const { count } = await prisma.user.updateMany({
      where: { id: parsed.userId, deactivatedAt: null, purgedAt: null },
      data: { notificationEmail: parsed.email },
    });
    // Zero rows means the scoped write was REFUSED (account disabled/purged/
    // deleted inside the token's TTL): nothing was stored, so never say it was.
    if (count !== 1) {
      return resultPage(locale, t("apiAuth.emailConfirm.errorTitle"), t("apiAuth.emailConfirm.errorBody"), false);
    }
  } catch (err) {
    console.error("[notif-email] confirm update failed:", err instanceof Error ? err.message : err);
    return resultPage(locale, t("apiAuth.emailConfirm.errorTitle"), t("apiAuth.emailConfirm.errorBody"), false);
  }

  // Where the server's outbound mail is delivered just changed: leave a trail
  // beside the password-change audit. No session here (the token was the
  // credential), so the row carries the bound account's id plus the clicker's
  // ip/UA from the request; the address itself is deliberately not recorded.
  // After the commit, swallowing (guardrail 26).
  void (async () => {
    const owner = await prisma.user
      .findUnique({ where: { id: parsed.userId }, select: { name: true, email: true } })
      .catch(() => null);
    await logAudit({
      userId: parsed.userId,
      userName: owner?.name ?? owner?.email ?? "unknown",
      action: "SETTINGS_CHANGE",
      target: `user:${parsed.userId}`,
      details: { kind: "notification-email-verified" },
      ...auditContext(req),
    });
  })();

  return resultPage(locale, t("apiAuth.emailConfirm.successTitle"), t("apiAuth.emailConfirm.successBody"), true);
}
