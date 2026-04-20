import { NextRequest, NextResponse } from "next/server";
import { auth, isTokenExpired } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { safeFetchTrusted } from "@/lib/safe-fetch";

async function arrFetch<T>(url: string, apiKey: string, path: string): Promise<T> {
  const res = await safeFetchTrusted(`${url.replace(/\/$/, "")}${path}`, {
    headers: { "X-Api-Key": apiKey },
    cache: "no-store",
    timeoutMs: 15_000,
  });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json() as Promise<T>;
}

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session || isTokenExpired(session) || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

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

  try {
    const [rootFolders, qualityProfiles] = await Promise.all([
      arrFetch<{ path: string }[]>(map[urlKey], map[keyKey], "/api/v3/rootfolder"),
      arrFetch<{ id: number; name: string }[]>(map[urlKey], map[keyKey], "/api/v3/qualityprofile"),
    ]);
    return NextResponse.json({ rootFolders, qualityProfiles });
  } catch (err) {
    console.error(`[settings/arr-options] Failed to fetch ${service} options:`, err);
    return NextResponse.json({ error: `Could not connect to ${service}` }, { status: 502 });
  }
}
