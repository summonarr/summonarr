import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { arrFetch } from "@/lib/arr";

export async function GET(req: NextRequest) {
  const session = await requireAuth({ role: "ADMIN" });
  if (session instanceof NextResponse) return session;

  const service = req.nextUrl.searchParams.get("service");
  if (service !== "radarr" && service !== "sonarr") {
    return NextResponse.json({ error: "service must be radarr or sonarr" }, { status: 400 });
  }

  const urlKey = service === "radarr" ? "radarrUrl" : "sonarrUrl";
  const keyKey = service === "radarr" ? "radarrApiKey" : "sonarrApiKey";
  const rows = await prisma.setting.findMany({ where: { key: { in: [urlKey, keyKey] } } });
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));

  if (!map[urlKey] || !map[keyKey]) {
    return NextResponse.json({ error: `${service} is not configured` }, { status: 422 });
  }

  const cfg = { url: map[urlKey].replace(/\/$/, ""), apiKey: map[keyKey] };

  try {
    const [rootFolders, qualityProfiles] = await Promise.all([
      arrFetch<{ path: string }[]>(cfg, "/api/v3/rootfolder"),
      arrFetch<{ id: number; name: string }[]>(cfg, "/api/v3/qualityprofile"),
    ]);
    return NextResponse.json({ rootFolders, qualityProfiles });
  } catch (err) {
    console.error(`[settings/arr-options] Failed to fetch ${service} options:`, err);
    return NextResponse.json({ error: `Could not connect to ${service}` }, { status: 502 });
  }
}
