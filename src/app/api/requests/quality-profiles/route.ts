import { NextResponse } from "next/server";
import { withPermission } from "@/lib/api-auth";
import { Permission, canRequestInstance, hasPermission, parseInstanceGrants } from "@/lib/permissions";
import { listQualityProfiles } from "@/lib/arr";
import { isValidInstanceSlug } from "@/lib/arr-instances";
import { getArrInstances } from "@/lib/arr-instance-registry";
import { prisma } from "@/lib/prisma";

// Quality profiles for the Radarr/Sonarr instance a given request targets, so the
// approve UI can offer "approve with profile X", and the request UI can offer a
// request-time picker to REQUEST_ADVANCED power users. Guarded by MANAGE_REQUESTS
// OR REQUEST_ADVANCED (not withAdmin — settings' arr-options route is ADMIN-only
// and would 403 a non-admin approver/requester).
//   ?mediaType=MOVIE|TV  → radarr | sonarr
//   ?instance=<slug>     → any instance slug ("" default, "4k", named)
//   ?is4k=true           → legacy shorthand for instance=4k
export const GET = withPermission([Permission.MANAGE_REQUESTS, Permission.REQUEST_ADVANCED])(async (req, _ctx, session) => {
  const sp = req.nextUrl.searchParams;
  const mediaType = sp.get("mediaType");
  if (mediaType !== "MOVIE" && mediaType !== "TV") {
    return NextResponse.json({ error: "mediaType must be MOVIE or TV" }, { status: 400 });
  }
  const service = mediaType === "MOVIE" ? "radarr" : "sonarr";
  const rawInstance = sp.get("instance");
  const variant =
    rawInstance !== null ? rawInstance.trim() : sp.get("is4k") === "true" ? "4k" : "";
  if (!isValidInstanceSlug(variant)) {
    return NextResponse.json({ error: "Invalid instance" }, { status: 400 });
  }

  // listQualityProfiles is deliberately permission-agnostic (see arr.ts), so this
  // route is the only gate on WHICH instance a requester may read. Mirror the POST
  // /api/requests capability check (guardrail 32): a NAMED or 4K instance is a
  // per-user grant, and without this a REQUEST_ADVANCED holder could enumerate an
  // instance's profile list, its default id, and (200 vs 422) which slugs exist.
  // Only non-default slugs are gated — the default ("") is open to any requester,
  // exactly as canRequestInstance treats it — and a MANAGE_REQUESTS approver
  // short-circuits, so the approve picker keeps working for every instance.
  if (variant !== "" && !hasPermission(session.user.permissions, Permission.MANAGE_REQUESTS)) {
    const [instances, user, request4kAllRow] = await Promise.all([
      getArrInstances(service),
      prisma.user.findUnique({ where: { id: session.user.id }, select: { instanceGrants: true } }),
      prisma.setting.findUnique({ where: { key: "request4kAll" } }),
    ]);
    const inst = instances.find((i) => i.slug === variant);
    // Same 403 for an unknown slug as for an ungranted one, so the response can't
    // be used to probe which named instances are registered.
    if (
      !inst ||
      !canRequestInstance(
        session.user.permissions,
        inst,
        parseInstanceGrants(user?.instanceGrants),
        mediaType,
        request4kAllRow?.value === "true",
      )
    ) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  let result: Awaited<ReturnType<typeof listQualityProfiles>>;
  try {
    result = await listQualityProfiles(service, variant);
  } catch (err) {
    console.error(`[requests/quality-profiles] Failed to fetch ${service} profiles:`, err);
    return NextResponse.json({ error: `Could not connect to ${service}` }, { status: 502 });
  }

  if (!result) {
    const label = variant === "" ? service : `${service} (${variant})`;
    return NextResponse.json({ error: `${label} is not configured` }, { status: 422 });
  }

  return NextResponse.json({ qualityProfiles: result.profiles, defaultId: result.defaultId });
});
