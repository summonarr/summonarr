import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { getIpLookup } from "@/lib/ip-lookup";
import { checkRateLimit } from "@/lib/rate-limit";

export const GET = withAdmin(async (req, _ctx, session) => {
  // Per-admin rate limit. Every lookup makes a billed call to ipinfo.io, so an
  // unbounded loop would burn the monthly quota. 60 per 60s is generous enough to
  // absorb the activity UI's bursts (resolving a list of session IPs) while still
  // capping a sustained abuse loop.
  if (!checkRateLimit(`admin-ip-lookup:${session.user.id}`, 60, 60 * 1000)) {
    return NextResponse.json({ error: "Too many lookups — try again shortly." }, { status: 429 });
  }
  const ip = req.nextUrl.searchParams.get("ip")?.trim();
  if (!ip) return NextResponse.json({ error: "ip required" }, { status: 400 });

  const result = await getIpLookup(ip);
  if (!result) return NextResponse.json({ error: "Lookup failed or unconfigured" }, { status: 404 });

  return NextResponse.json(result);
});
