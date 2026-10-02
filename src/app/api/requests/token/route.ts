import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { generateRequestToken } from "@/lib/request-token";
import { translatorForRequest } from "@/lib/i18n/server-locale";

// Mints the short-lived HMAC token (scoped to tmdbId+mediaType+user) that
// POST /api/requests requires — gates request creation to the actual UI flow.
export const GET = withAuth(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  const tmdbId = parseInt(req.nextUrl.searchParams.get("tmdbId") ?? "", 10);
  const mediaType = req.nextUrl.searchParams.get("mediaType");

  if (!Number.isInteger(tmdbId) || tmdbId <= 0) {
    return NextResponse.json({ error: t("apiUser.common.tmdbIdPositive") }, { status: 400 });
  }
  if (mediaType !== "MOVIE" && mediaType !== "TV") {
    return NextResponse.json({ error: t("apiUser.common.mediaTypeInvalid") }, { status: 400 });
  }

  const token = generateRequestToken(tmdbId, mediaType, session.user.id);
  return NextResponse.json({ token });
});
