import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { hashVerifyToken, parseVerifyIdentifier } from "@/lib/notification-email-verify";

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

const PAGE_HEAD = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`;
const BODY_OPEN = `<body style="font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;background:#09090b;color:#e4e4e7;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center">
<div style="max-width:420px;margin:16px;padding:28px;text-align:center;border:1px solid #27272a;border-radius:12px;background:#18181b">`;

function resultPage(title: string, message: string, ok: boolean): NextResponse {
  const html = `${PAGE_HEAD}<title>${escapeHtml(title)}</title></head>
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
  const token = new URL(req.url).searchParams.get("token");
  if (!token) {
    return resultPage("Invalid link", "This verification link is missing its token.", false);
  }

  const row = await prisma.verificationToken.findUnique({ where: { token: hashVerifyToken(token) } });
  if (!row) {
    return resultPage("Link expired or already used", "Request a fresh verification email from your Summonarr profile.", false);
  }

  if (row.expires.getTime() < Date.now()) {
    return resultPage("Link expired", "This verification link has expired. Request a new one from your profile.", false);
  }

  const parsed = parseVerifyIdentifier(row.identifier);
  if (!parsed) {
    return resultPage("Invalid link", "This verification link is malformed.", false);
  }

  // The token is opaque hex, but escape into the action URL defensively; the
  // email is reflected as text content and MUST be HTML-escaped.
  const action = `/api/profile/notification-email/confirm?token=${encodeURIComponent(token)}`;
  const html = `${PAGE_HEAD}<title>Confirm notification email</title></head>
${BODY_OPEN}
<div style="font-size:34px;line-height:1;margin-bottom:12px">✉</div>
<h1 style="font-size:18px;font-weight:600;margin:0 0 8px">Confirm your notification email</h1>
<p style="font-size:13px;color:#a1a1aa;line-height:1.55;margin:0 0 20px">Bind <strong style="color:#e4e4e7">${escapeHtml(parsed.email)}</strong> to your Summonarr account so request updates are sent there.</p>
<form method="post" action="${escapeHtml(action)}">
<button type="submit" style="display:inline-block;width:100%;padding:11px 16px;font-size:14px;font-weight:600;color:#09090b;background:#e4e4e7;border:none;border-radius:8px;cursor:pointer">Confirm this email</button>
</form>
</div></body></html>`;
  return new NextResponse(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

// POST: the actual bind. Only a human form submission reaches here.
export async function POST(req: Request) {
  const token = new URL(req.url).searchParams.get("token");
  if (!token) {
    return resultPage("Invalid link", "This verification link is missing its token.", false);
  }

  const row = await prisma.verificationToken.findUnique({ where: { token: hashVerifyToken(token) } });
  if (!row) {
    return resultPage("Link expired or already used", "Request a fresh verification email from your Summonarr profile.", false);
  }

  // Single-use: consume the token FIRST so a double-submit can't re-trigger the bind.
  await prisma.verificationToken.delete({ where: { token: row.token } }).catch(() => {});

  if (row.expires.getTime() < Date.now()) {
    return resultPage("Link expired", "This verification link has expired. Request a new one from your profile.", false);
  }

  const parsed = parseVerifyIdentifier(row.identifier);
  if (!parsed) {
    return resultPage("Invalid link", "This verification link is malformed.", false);
  }

  try {
    // updateMany (not update): a since-deleted account no-ops instead of throwing;
    // the email value is never reflected into the HTML (avoids any injection).
    await prisma.user.updateMany({ where: { id: parsed.userId }, data: { notificationEmail: parsed.email } });
  } catch (err) {
    console.error("[notif-email] confirm update failed:", err instanceof Error ? err.message : err);
    return resultPage("Something went wrong", "We couldn't save your verified email. Try again from your profile.", false);
  }

  return resultPage(
    "Email verified",
    "Your notification email is confirmed. Summonarr will now send your request updates there. You can close this tab.",
    true,
  );
}
