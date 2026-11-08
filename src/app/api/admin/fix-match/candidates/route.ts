import { NextResponse } from "next/server";
import { withIssueAdmin } from "@/lib/api-auth";
import { isTmdbIdInRange } from "@/lib/tmdb-id";
import { prisma } from "@/lib/prisma";
import { getPlexConfig } from "@/lib/plex-config";
import { candidateCacheKey, getCachedCandidates, setCachedCandidates } from "@/lib/fix-match-candidate-cache";
import {
  arrConfirmedTitle,
  enrichCandidates,
  resolveArrMatch,
  resolveTargetDetails,
  searchPlexCandidates,
  type CandidatesResponse,
} from "@/lib/fix-match-candidates";
import { pickSuggestedGuid } from "@/lib/fix-match-scoring";
import { plexAdminHeaders, rowWithPathFor } from "@/lib/fix-match-shared";
import { libraryPathFor } from "@/lib/library-path-view";
import { tmdbAuth } from "@/lib/tmdb-auth";
import { DEFAULT_MEDIA_INSTANCE, isValidMediaInstanceSlug } from "@/lib/media-instances";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { checkRateLimit } from "@/lib/rate-limit";

// The picker's types live with the code that builds them (fix-match-candidates.ts);
// re-exported for the dialogs that import them from here.
export type { CandidateMatch, CandidatesResponse, PlexCandidate } from "@/lib/fix-match-candidates";

type CandidatesQuery = {
  tmdbId: number;
  correctTmdbId: number;
  mediaType: "MOVIE" | "TV";
  arrTmdbIdHint: number | null;
  serverInstance: string;
};
type Translate = ReturnType<typeof translatorForRequest>;

// Jellyfin mode: there is no candidate list to pick from — the fix-match POST
// applies the exact TMDB id deterministically (it refuses any search result
// carrying a different id; see that route). This feeds the pre-apply
// CONFIRMATION card instead: the target's TMDB details, the file about to be
// re-identified, and the same live arr cross-check the Plex picker shows. Same
// response shape with the Plex-only fields neutral, so every existing
// CandidatesResponse consumer is unchanged.
async function jellyfinConfirmation(q: CandidatesQuery, perms: bigint, t: Translate): Promise<NextResponse> {
  const [jfItem, plexRows] = await Promise.all([
    prisma.jellyfinLibraryItem.findFirst({
      where: { tmdbId: q.tmdbId, mediaType: q.mediaType, serverInstance: q.serverInstance },
      select: { jellyfinItemId: true, filePath: true, title: true, year: true },
    }),
    // Cross-server display hint — deliberately unscoped, mirroring (and for
    // the same reason as) the Jellyfin read in the Plex mode below.
    prisma.plexLibraryItem.findMany({
      where: { tmdbId: q.tmdbId, mediaType: q.mediaType },
      select: { serverInstance: true, filePath: true },
      orderBy: { serverInstance: "asc" },
    }),
  ]);
  if (!jfItem?.jellyfinItemId) {
    return NextResponse.json({ error: t("apiAdmin.fixMatch.jellyfinItemNotFound") }, { status: 404 });
  }
  const plexHint = rowWithPathFor(plexRows, q.serverInstance);
  // TMDB and the arr cross-check need nothing from each other.
  const [{ target }, arr] = await Promise.all([
    resolveTargetDetails(q.correctTmdbId, q.mediaType),
    resolveArrMatch(q.mediaType, q.tmdbId, q.correctTmdbId, jfItem.filePath ?? null),
  ]);
  return NextResponse.json({
    candidates: [],
    ...target,
    arrConfirmedTmdbId: arr.arrConfirmedTmdbId,
    arrConfirmedTitle: await arrConfirmedTitle(q.mediaType, arr.arrConfirmedTmdbId, q.correctTmdbId, target.targetTitle),
    arrPathAgrees: arr.arrPathAgrees,
    ratingKey: "",
    // The caller's view of the paths (library-path-view.ts), like the Plex
    // mode's answer below.
    plexFilePath: libraryPathFor(perms, plexHint?.filePath),
    jellyfinFilePath: libraryPathFor(perms, jfItem.filePath),
    serverInstance: q.serverInstance,
    currentTitle: jfItem.title ?? null,
    currentYear: jfItem.year ?? null,
  } satisfies CandidatesResponse);
}

// Plex mode: the server's own /matches candidates for the item, scored.
async function plexCandidates(q: CandidatesQuery, perms: bigint, t: Translate): Promise<NextResponse> {
  const [item, jellyfinRows] = await Promise.all([
    prisma.plexLibraryItem.findFirst({
      where: { tmdbId: q.tmdbId, mediaType: q.mediaType, serverInstance: q.serverInstance },
      select: { plexRatingKey: true, filePath: true, title: true, year: true },
    }),
    // Deliberately NOT scoped by `serverInstance`: that slug names the PLEX
    // server this listing is for, and the two sides of a bad match are
    // independent instances — bad-matches.ts pairs library rows by relative
    // path across every configured server and gives each side its own
    // `serverInstance`. Scoping the Jellyfin read with the Plex slug therefore
    // blanked (or mis-sourced) the hint on exactly the cross-instance mismatch
    // an admin opens this picker to resolve. Widening is safe because
    // `jellyfinFilePath` is display-only — nothing is written from it.
    prisma.jellyfinLibraryItem.findMany({
      where: { tmdbId: q.tmdbId, mediaType: q.mediaType },
      select: { serverInstance: true, filePath: true },
      orderBy: { serverInstance: "asc" },
    }),
  ]);
  // Requested instance first, so every answer this route already gives is
  // unchanged — a single-server deployment (every row on "") is byte-identical
  // (guardrail 35), and a multi-server one only gains a path where it used to
  // report none.
  const jellyfinItem = rowWithPathFor(jellyfinRows, q.serverInstance);
  if (!item?.plexRatingKey) {
    return NextResponse.json({ error: t("apiAdmin.fixMatch.plexRatingKeyNotFound") }, { status: 404 });
  }
  const cacheKey = candidateCacheKey({
    serverInstance: q.serverInstance, ratingKey: item.plexRatingKey, correctTmdbId: q.correctTmdbId, arrHint: q.arrTmdbIdHint,
    mediaType: q.mediaType, tmdbId: q.tmdbId,
  });
  // The cache holds the full body (it is keyed by the title, not the caller);
  // every answer, cached or fresh, leaves through the caller's view of the
  // two paths (library-path-view.ts: ADMIN sees the path, a MANAGE_ISSUES
  // delegate the file name).
  const viewOf = (body: CandidatesResponse): CandidatesResponse => ({
    ...body,
    plexFilePath: libraryPathFor(perms, body.plexFilePath),
    jellyfinFilePath: libraryPathFor(perms, body.jellyfinFilePath),
  });
  const cached = getCachedCandidates<CandidatesResponse>(cacheKey);
  if (cached) return NextResponse.json(viewOf(cached));
  // Coerce to break taint from the DB-read string before interpolating into the
  // Plex admin-token URL below (rating keys are always integers).
  const safeRatingKey = String(parseInt(item.plexRatingKey, 10) || 0);

  const plexConfig = await getPlexConfig(q.serverInstance);
  if (!plexConfig.url || !plexConfig.token) {
    return NextResponse.json({ error: t("apiAdmin.common.plexNotConfigured") }, { status: 500 });
  }
  const serverUrl = plexConfig.url.replace(/\/$/, "");

  // TMDB and the arr cross-check run side by side; the Plex searches need the
  // target's ids, so they follow TMDB — beside the arr pick's name.
  const [{ target, failed: tmdbFailed }, arr] = await Promise.all([
    resolveTargetDetails(q.correctTmdbId, q.mediaType),
    resolveArrMatch(q.mediaType, q.tmdbId, q.correctTmdbId, item.filePath ?? null),
  ]);
  const [confirmedTitle, plex] = await Promise.all([
    arrConfirmedTitle(q.mediaType, arr.arrConfirmedTmdbId, q.correctTmdbId, target.targetTitle),
    searchPlexCandidates(
      serverUrl, safeRatingKey, plexAdminHeaders(plexConfig.token),
      { correctTmdbId: q.correctTmdbId, imdbId: target.targetImdbId, title: target.targetTitle, year: target.targetYear },
      q.arrTmdbIdHint,
    ),
  ]);
  const { candidates, failed: enrichFailed } = await enrichCandidates(
    plex.raw, q.mediaType, q.correctTmdbId, target, arr.arrConfirmedTmdbId, q.arrTmdbIdHint, tmdbAuth(),
  );
  const suggestedGuid = pickSuggestedGuid(candidates, plex.firstImdbGuid);
  for (const c of candidates) {
    c.suggested = c.guid === suggestedGuid;
  }

  const responseBody = {
    candidates,
    ...target,
    arrConfirmedTmdbId: arr.arrConfirmedTmdbId,
    arrConfirmedTitle: confirmedTitle,
    arrPathAgrees: arr.arrPathAgrees,
    ratingKey: item.plexRatingKey,
    plexFilePath: item.filePath ?? null,
    jellyfinFilePath: jellyfinItem?.filePath ?? null,
    serverInstance: q.serverInstance,
    currentTitle: item.title ?? null,
    currentYear: item.year ?? null,
  } satisfies CandidatesResponse;
  // Only a whole answer is kept: one built while a Plex search, TMDB or the
  // arr got no answer would re-serve that gap (an empty list, a missing
  // confirmation) for the cache's lifetime — the next open asks again instead.
  if (!(tmdbFailed || arr.failed || plex.failed || enrichFailed)) setCachedCandidates(cacheKey, responseBody);
  return NextResponse.json(viewOf(responseBody));
}

export const GET = withIssueAdmin(async (request, _ctx, session) => {
  const t = translatorForRequest(request);
  // Every TV call pulls the whole Sonarr series table (up to the 50 MB
  // ARR_FETCH_MAX_BYTES), fires five 30s Plex agent searches and up to N TMDB
  // detail reads — a stuck picker (re-render loop) or a script from any
  // MANAGE_ISSUES holder had no bound at all, where the sibling POST caps at
  // 10/min. 30/min is generous for a human paging through candidates.
  if (!checkRateLimit(`fix-match-candidates:${session.user.id}`, 30, 60_000)) {
    return NextResponse.json({ error: t("apiAdmin.fixMatch.tooMany") }, { status: 429 });
  }
  const { searchParams } = new URL(request.url);
  const server             = searchParams.get("server");
  const mediaTypeRaw       = searchParams.get("mediaType");
  // Validated, not just cast: an arbitrary value reaching the Prisma enum
  // filter throws PrismaClientValidationError → an unhandled 500 where the
  // sibling POST answers 400.
  const mediaType: "MOVIE" | "TV" | null =
    mediaTypeRaw === "MOVIE" || mediaTypeRaw === "TV" ? mediaTypeRaw : null;
  const tmdbIdRaw          = parseInt(searchParams.get("tmdbId") ?? "", 10);
  const correctTmdbIdRaw   = parseInt(searchParams.get("correctTmdbId") ?? "", 10);
  const arrTmdbIdParam     = searchParams.get("arrTmdbId");
  const arrTmdbIdHintRaw   = arrTmdbIdParam ? parseInt(arrTmdbIdParam, 10) : null;

  const tmdbId        = isTmdbIdInRange(tmdbIdRaw)        ? tmdbIdRaw        : 0;
  const correctTmdbId = isTmdbIdInRange(correctTmdbIdRaw) ? correctTmdbIdRaw : 0;
  const arrTmdbIdHint = arrTmdbIdHintRaw !== null && isTmdbIdInRange(arrTmdbIdHintRaw)
    ? arrTmdbIdHintRaw
    : null;

  if (!server || !tmdbId || !mediaType || !correctTmdbId) {
    return NextResponse.json({ error: t("apiAdmin.fixMatch.missingParams") }, { status: 400 });
  }
  if (server !== "plex" && server !== "jellyfin") {
    return NextResponse.json({ error: t("apiAdmin.common.serverPlexOrJellyfin") }, { status: 400 });
  }

  // Which configured server's library row (and therefore whose ratingKey and
  // whose /matches endpoint) this listing is for. Absent ⇒ the default server,
  // so every pre-multi-server caller keeps its exact behaviour.
  const serverInstanceParam = searchParams.get("serverInstance");
  if (serverInstanceParam !== null && !isValidMediaInstanceSlug(serverInstanceParam)) {
    return NextResponse.json({ error: t("apiAdmin.common.invalidServerInstance", { slug: String(serverInstanceParam) }) }, { status: 400 });
  }
  const q: CandidatesQuery = { tmdbId, correctTmdbId, mediaType, arrTmdbIdHint, serverInstance: serverInstanceParam ?? DEFAULT_MEDIA_INSTANCE };
  return server === "jellyfin"
    ? jellyfinConfirmation(q, session.user.permissions, t)
    : plexCandidates(q, session.user.permissions, t);
});
