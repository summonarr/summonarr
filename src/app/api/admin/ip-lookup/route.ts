import { NextResponse } from "next/server";
import { isIP } from "node:net";
import { withAdmin } from "@/lib/api-auth";
import { getIpLookup, IpLookupUnavailableError } from "@/lib/ip-lookup";
import { checkRateLimit } from "@/lib/rate-limit";
import { translatorForRequest } from "@/lib/i18n/server-locale";

export const GET = withAdmin(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  // Per-admin rate limit. Every lookup makes a billed call to ipinfo.io, so an
  // unbounded loop would burn the monthly quota. 60 per 60s is generous enough to
  // absorb the activity UI's bursts (resolving a list of session IPs) while still
  // capping a sustained abuse loop.
  if (!checkRateLimit(`admin-ip-lookup:${session.user.id}`, 60, 60 * 1000)) {
    return NextResponse.json({ error: t("apiAdmin.ipLookup.tooMany") }, { status: 429 });
  }
  const ip = req.nextUrl.searchParams.get("ip")?.trim();
  if (!ip) return NextResponse.json({ error: t("apiAdmin.ipLookup.ipRequired") }, { status: 400 });
  // Malformed input is the caller's error (400), not "lookup failed" (404) —
  // the client negative-caches a 404 for the whole session.
  if (isIP(ip) === 0) return NextResponse.json({ error: t("apiAdmin.ipLookup.ipInvalid") }, { status: 400 });

  // Three outcomes, three statuses — the activity UI (ip-info.tsx) caches a 404
  // as permanent and deliberately does NOT cache anything else:
  //   result  → 200
  //   null    → 404  (no ipinfo token configured; permanent until an admin adds one)
  //   throw IpLookupUnavailableError → 503 (timeout / 5xx / 429 upstream with no
  //            cached row; transient — the next open must retry)
  let result;
  try {
    result = await getIpLookup(ip);
  } catch (err) {
    if (err instanceof IpLookupUnavailableError) {
      return NextResponse.json(
        { error: t("apiAdmin.ipLookup.unavailable") },
        { status: 503, headers: { "Retry-After": "30" } },
      );
    }
    throw err;
  }
  if (!result) return NextResponse.json({ error: t("apiAdmin.ipLookup.failed") }, { status: 404 });

  return NextResponse.json(result);
});
