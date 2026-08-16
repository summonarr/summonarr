import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/rate-limit";
import { tooManyRequests } from "@/lib/http";
import { getArrInstances } from "@/lib/arr-instance-registry";
import { FOURK_ARR_INSTANCE } from "@/lib/arr-instances";
import { canRequestInstance, parseInstanceGrants } from "@/lib/permissions";
import { isBlacklisted } from "@/lib/blacklist";

export const dynamic = "force-dynamic";

// GET — the NAMED Radarr/Sonarr instances the CALLER may request a given title
// on, with that title's per-instance request/availability state. The native
// mirror of the `namedTargets` block the web movie/TV detail pages compute
// inline to render their "Request on <instance>" buttons; both must agree, so
// keep this in step with those pages.
//
// Scope is deliberately narrow — NAMED slugs only. The default instance ("") is
// the plain Request button and "4k" is the dedicated 4K button; both are already
// modelled on the media payload, and folding them in here would give clients two
// competing sources of truth for the same two actions.
//
// This is an ENUMERATION endpoint, so the eligibility filter is what keeps it
// safe: it returns only instances `canRequestInstance` already allows this
// caller to target, which is exactly the set they can act on anyway. That is why
// it does not weaken the sibling rule in /api/requests/quality-profiles, which
// answers 403 identically for an unknown and an ungranted slug so a requester
// can't probe which named instances exist — nothing here reveals a slug the
// caller isn't already entitled to use.
//
// Query: tmdbId=<int>&mediaType=MOVIE|TV
export const GET = withAuth(async (req, _ctx, session) => {
  if (!checkRateLimit(`request-instances:${session.user.id}`, 60, 60_000)) {
    return tooManyRequests(60);
  }

  const sp = req.nextUrl.searchParams;
  const mediaType = sp.get("mediaType");
  if (mediaType !== "MOVIE" && mediaType !== "TV") {
    return NextResponse.json({ error: "mediaType must be MOVIE or TV" }, { status: 400 });
  }
  const tmdbId = Number(sp.get("tmdbId"));
  if (!Number.isInteger(tmdbId) || tmdbId <= 0) {
    return NextResponse.json({ error: "tmdbId must be a positive integer" }, { status: 400 });
  }

  const service = mediaType === "MOVIE" ? "radarr" : "sonarr";
  const instances = await getArrInstances(service);
  const named = instances.filter((i) => i.slug !== "" && i.slug !== FOURK_ARR_INSTANCE);
  // Grants need a DB read (they aren't in the session JWT), so only pay for it
  // when a named instance actually exists — the same short-circuit the web pages
  // use.
  if (named.length === 0) return NextResponse.json({ instances: [] });

  // A blacklisted title has no requestable target at all (the request POST 403s),
  // so report none rather than offering buttons that cannot succeed.
  if (await isBlacklisted(tmdbId, mediaType)) return NextResponse.json({ instances: [] });

  const viewer = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { instanceGrants: true },
  });
  const grants = parseInstanceGrants(viewer?.instanceGrants);
  const eligible = named.filter((inst) =>
    canRequestInstance(session.user.permissions, inst, grants, mediaType),
  );
  if (eligible.length === 0) return NextResponse.json({ instances: [] });

  const rows = await Promise.all(
    eligible.map(async (inst) => {
      const [namedRequest, namedAvailable] = await Promise.all([
        prisma.mediaRequest.findFirst({
          where: {
            tmdbId,
            mediaType,
            requestedBy: session.user.id,
            arrInstance: inst.slug,
            status: { not: "DECLINED" },
          },
          select: { id: true },
        }),
        mediaType === "MOVIE"
          ? prisma.radarrAvailableItem.findUnique({
              where: { tmdbId_arrInstance: { tmdbId, arrInstance: inst.slug } },
            })
          : prisma.sonarrAvailableItem.findUnique({
              where: { tmdbId_arrInstance: { tmdbId, arrInstance: inst.slug } },
            }),
      ]);
      return {
        slug: inst.slug,
        name: inst.name,
        requested: !!namedRequest,
        available: !!namedAvailable,
      };
    }),
  );

  return NextResponse.json({ instances: rows });
});
