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

    // Sonarr v3 only: language profiles for the per-instance default picker.
    // v4 removed them — the endpoint 404s, or (on some builds) returns a single
    // placeholder named "Deprecated" — so a failure or an empty post-filter list
    // means "this Sonarr has no language profiles" and the field is omitted
    // entirely rather than failing the whole options fetch. The UI hides the
    // picker when the field is absent.
    let languageProfiles: { id: number; name: string }[] | undefined;
    if (service === "sonarr") {
      try {
        const raw = await arrFetch<{ id: number; name: string }[]>(cfg, "/api/v3/languageprofile");
        const usable = (Array.isArray(raw) ? raw : []).filter((p) => p?.name !== "Deprecated");
        if (usable.length > 0) languageProfiles = usable.map((p) => ({ id: p.id, name: p.name }));
      } catch {
        // Sonarr v4 — no language profiles to offer.
      }
    }

    return NextResponse.json({ rootFolders, qualityProfiles, ...(languageProfiles ? { languageProfiles } : {}) });
  } catch (err) {
    console.error(`[settings/arr-options] Failed to fetch ${service} options:`, err);
    return NextResponse.json({ error: `Could not connect to ${service}` }, { status: 502 });
  }
});
