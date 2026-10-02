import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { getBadMatches } from "@/lib/bad-matches";
import { translatorForRequest } from "@/lib/i18n/server-locale";

// Native-client bad-match list for the admin Library screen. Mirrors the
// server-rendered list in src/app/(app)/admin/library/page.tsx. Apply a fix via
// the existing POST /api/admin/fix-match.
export const GET = withAdmin(async (request) => {
  const t = translatorForRequest(request);
  const typeParam = request.nextUrl.searchParams.get("mediaType");
  const activeType = typeParam === "movie" ? "MOVIE" : typeParam === "tv" ? "TV" : undefined;
  try {
    const badMatches = await getBadMatches(activeType);
    return NextResponse.json({ badMatches });
  } catch (err) {
    console.error("[library/bad-matches] Failed:", err);
    return NextResponse.json({ error: t("apiAdmin.library.badMatchesFailed") }, { status: 500 });
  }
});
