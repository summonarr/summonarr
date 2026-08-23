import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { checkRateLimit } from "@/lib/rate-limit";
import { tooManyRequests } from "@/lib/http";
import { resolveNamedInstanceTargets } from "@/lib/named-instance-targets";
import { isBlacklisted } from "@/lib/blacklist";

export const dynamic = "force-dynamic";

// GET — the NAMED Radarr/Sonarr instances the CALLER may request a given title
// on, with that title's per-instance request/availability state. The native
// mirror of the `namedTargets` the web movie/TV detail pages render as their
// "Request on <instance>" buttons; both must agree, so all three now share the
// one resolver (resolveNamedInstanceTargets) rather than restating it.
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

  const rows = await resolveNamedInstanceTargets({
    tmdbId,
    mediaType,
    userId: session.user.id,
    permissions: session.user.permissions,
    blacklisted: await isBlacklisted(tmdbId, mediaType),
  });

  return NextResponse.json({ instances: rows });
});
