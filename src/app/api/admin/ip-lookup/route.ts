import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { getIpLookup } from "@/lib/ip-lookup";

export async function GET(req: NextRequest) {
  const session = await requireAuth({ role: "ADMIN" });
  if (session instanceof NextResponse) return session;

  const ip = req.nextUrl.searchParams.get("ip")?.trim();
  if (!ip) return NextResponse.json({ error: "ip required" }, { status: 400 });

  const result = await getIpLookup(ip);
  if (!result) return NextResponse.json({ error: "Lookup failed or unconfigured" }, { status: 404 });

  return NextResponse.json(result);
}
