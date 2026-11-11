import { NextResponse } from "next/server";
import type { Translator } from "@/lib/i18n/translate";

// A GET that starts upstream work (an indexer search, a manual-import scan) is
// not covered by the proxy's CSRF Origin check, which is for mutating requests,
// and the session cookie is SameSite=Lax: a signed-in admin's top-level
// navigation from another site carries it. Nothing can be READ that way, but
// the work still runs.
//
// Browsers say where a request came from in Sec-Fetch-Site. Only an explicit
// "cross-site" is refused: the app's own fetches send "same-origin", a typed
// address or bookmark sends "none", and a native app, curl or an older browser
// sends no header at all — all of those pass. This is a cost control on top of
// the admin gate, never an authorization input.
export function isCrossSiteRequest(headers: Headers): boolean {
  return headers.get("sec-fetch-site")?.trim().toLowerCase() === "cross-site";
}

// The 403 for such a request, or null to carry on.
export function crossSiteRefusal(req: { headers: Headers }, t: Translator): NextResponse | null {
  if (!isCrossSiteRequest(req.headers)) return null;
  return NextResponse.json({ error: t("apiAdmin.common.crossSiteRefused") }, { status: 403 });
}
