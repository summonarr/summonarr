import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { arrFetch } from "@/lib/arr";
import { arrSettingKey, isValidInstanceSlug } from "@/lib/arr-instances";

export const GET = withAdmin(async (req, _ctx, _session) => {
  const service = req.nextUrl.searchParams.get("service");
  if (service !== "radarr" && service !== "sonarr") {
    return NextResponse.json({ error: "service must be radarr or sonarr" }, { status: 400 });
  }
  // ?instance=<slug> selects a named instance's namespaced settings keys; the
  // legacy ?variant=4k spelling is still honored. "" = the default instance.
  const rawInstance = req.nextUrl.searchParams.get("instance");
  const instance = rawInstance != null
    ? rawInstance
    : req.nextUrl.searchParams.get("variant") === "4k" ? "4k" : "";
  if (!isValidInstanceSlug(instance)) {
    return NextResponse.json({ error: "invalid instance" }, { status: 400 });
  }

  const urlKey = arrSettingKey(service, instance, "Url");
  const keyKey = arrSettingKey(service, instance, "ApiKey");
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
});
