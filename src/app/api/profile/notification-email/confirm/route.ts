import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { hashVerifyToken, parseVerifyIdentifier } from "@/lib/notification-email-verify";

// PUBLIC (listed in isPublicPath in proxy.ts + ROUTE_EXCEPTIONS in
// audit-routes.mts): the one-time token in the query IS the credential. The link
// was mailed to the candidate address, so clicking it proves possession; on
// confirm we bind that address to the account. Single-use + short-lived.
export const dynamic = "force-dynamic";

function resultPage(title: string, message: string, ok: boolean): NextResponse {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
<body style="font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;background:#09090b;color:#e4e4e7;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center">
<div style="max-width:420px;margin:16px;padding:28px;text-align:center;border:1px solid #27272a;border-radius:12px;background:#18181b">
<div style="font-size:34px;line-height:1;margin-bottom:12px">${ok ? "✓" : "⚠"}</div>
<h1 style="font-size:18px;font-weight:600;margin:0 0 8px">${title}</h1>
<p style="font-size:13px;color:#a1a1aa;line-height:1.55;margin:0">${message}</p>
</div></body></html>`;
  return new NextResponse(html, {
    status: ok ? 200 : 400,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get("token");
  if (!token) {
    return resultPage("Invalid link", "This verification link is missing its token.", false);
  }

  const row = await prisma.verificationToken.findUnique({ where: { token: hashVerifyToken(token) } });
  if (!row) {
    return resultPage("Link expired or already used", "Request a fresh verification email from your Summonarr profile.", false);
  }

  // Single-use: consume the token FIRST so a double-click / email-scanner can't
  // re-trigger the bind.
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
