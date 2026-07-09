import { NextResponse } from "next/server";
import { withPermission } from "@/lib/api-auth";
import { Permission } from "@/lib/permissions";
import { listQualityProfiles } from "@/lib/arr";

// Quality profiles for the Radarr/Sonarr instance a given request targets, so the
// approve UI can offer "approve with profile X", and the request UI can offer a
// request-time picker to REQUEST_ADVANCED power users. Guarded by MANAGE_REQUESTS
// OR REQUEST_ADVANCED (not withAdmin — settings' arr-options route is ADMIN-only
// and would 403 a non-admin approver/requester).
//   ?mediaType=MOVIE|TV  → radarr | sonarr
//   ?is4k=true           → the optional 4K instance (default: HD)
export const GET = withPermission([Permission.MANAGE_REQUESTS, Permission.REQUEST_ADVANCED])(async (req, _ctx, _session) => {
  const sp = req.nextUrl.searchParams;
  const mediaType = sp.get("mediaType");
  if (mediaType !== "MOVIE" && mediaType !== "TV") {
    return NextResponse.json({ error: "mediaType must be MOVIE or TV" }, { status: 400 });
  }
  const service = mediaType === "MOVIE" ? "radarr" : "sonarr";
  const variant = sp.get("is4k") === "true" ? "4k" : "hd";

  let result: Awaited<ReturnType<typeof listQualityProfiles>>;
  try {
    result = await listQualityProfiles(service, variant);
  } catch (err) {
    console.error(`[requests/quality-profiles] Failed to fetch ${service} profiles:`, err);
    return NextResponse.json({ error: `Could not connect to ${service}` }, { status: 502 });
  }

  if (!result) {
    const label = variant === "4k" ? `${service} 4K` : service;
    return NextResponse.json({ error: `${label} is not configured` }, { status: 422 });
  }

  return NextResponse.json({ qualityProfiles: result.profiles, defaultId: result.defaultId });
});
