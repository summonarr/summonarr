import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { getIpLookup } from "@/lib/ip-lookup";

export const GET = withAdmin(async (req, _ctx, _session) => {
  const ip = req.nextUrl.searchParams.get("ip")?.trim();
  if (!ip) return NextResponse.json({ error: "ip required" }, { status: 400 });

  const result = await getIpLookup(ip);
  if (!result) return NextResponse.json({ error: "Lookup failed or unconfigured" }, { status: 404 });

  return NextResponse.json(result);
});
