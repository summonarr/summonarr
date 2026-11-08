import { NextResponse } from "next/server";
import { withAuth, type SummonarrSession } from "@/lib/api-auth";
import { parsePageParam } from "@/lib/pagination";
import { readJsonCapped } from "@/lib/body-size";
import { prisma } from "@/lib/prisma";
import { checkRateLimit, parseRateLimit } from "@/lib/rate-limit";
import { tooManyRequests } from "@/lib/http";
import { maintenanceGuard } from "@/lib/maintenance";
import { resolveMediaMeta } from "@/lib/request-meta";
import { sanitizeOptional, sanitizeContainsSearch } from "@/lib/sanitize";
import { verifyRequestToken } from "@/lib/request-token";
import { alertIfVoteThresholdReached, sweepPendingVoteAlerts } from "@/lib/deletion-vote-threshold";
import { isFeatureEnabled } from "@/lib/features";
import { getVisibleServerInstances } from "@/lib/media-visibility";
import { loadVotesList, VOTES_PAGE_SIZE } from "@/lib/votes-list-data";
import { isTmdbIdInRange } from "@/lib/tmdb-id";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { isPrismaErrorCode } from "@/lib/prisma-errors";

const VALID_VOTE_SORTS = ["votes", "recent"] as const;

export const GET = withAuth(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  // Same gate as POST below and /api/votes/[tmdbId]: disabling the feature
  // must switch off the whole surface — this listing carries other users'
  // free-text vote reasons, not just the caller's own state.
  if (!(await isFeatureEnabled("feature.page.votes"))) {
    return NextResponse.json({ error: t("apiUser.votes.disabled") }, { status: 403 });
  }
  if (!checkRateLimit(`votes-list:${session.user.id}`, 30, 60_000)) {
    return tooManyRequests(60);
  }

  const sp = req.nextUrl.searchParams;
  const page = parsePageParam(sp);
  const sortParam = sp.get("sort");
  const sort =
    sortParam && (VALID_VOTE_SORTS as readonly string[]).includes(sortParam)
      ? (sortParam as (typeof VALID_VOTE_SORTS)[number])
      : "votes";
  // Mirrors the web /votes page: `mine` scopes to the caller's votes, `q` matches
  // the title, `recent` orders groups by their most-recent vote. The paging,
  // visibility scope and per-title reasons live in votes-list-data.ts.
  const { items, total } = await loadVotesList(session, {
    page,
    mine: sp.get("mine") === "1",
    sort,
    q: sanitizeContainsSearch((sp.get("q") ?? "").trim()),
  });
  return NextResponse.json({ items, total, page, pageSize: VOTES_PAGE_SIZE });
});

// The vote's body fields, or the message key of the 400 refusing them.
function parseVoteBody(body: { tmdbId?: unknown; mediaType?: unknown; reason?: unknown }):
  | { ok: true; tmdbId: number; mediaType: "MOVIE" | "TV"; reason: string | undefined }
  | { ok: false; errorKey: string } {
  const { tmdbId, mediaType, reason } = body;
  if (!tmdbId || !mediaType) return { ok: false, errorKey: "apiUser.common.tmdbIdMediaTypeRequired" };
  if (typeof tmdbId !== "number" || !Number.isInteger(tmdbId) || tmdbId <= 0) return { ok: false, errorKey: "apiUser.common.tmdbIdPositive" };
  if (!isTmdbIdInRange(tmdbId)) return { ok: false, errorKey: "apiUser.common.tmdbIdOutOfRange" };
  if (mediaType !== "MOVIE" && mediaType !== "TV") return { ok: false, errorKey: "apiUser.common.mediaTypeInvalid" };
  if (reason !== undefined && (typeof reason !== "string" || reason.length > 200)) return { ok: false, errorKey: "apiUser.votes.reasonTooLong" };
  return { ok: true, tmdbId, mediaType, reason };
}

// Why this voter may not vote on the title, or null when they may.
async function voteRefusal(
  session: SummonarrSession,
  tmdbId: number,
  mediaType: "MOVIE" | "TV",
): Promise<"not-in-library" | "own-request" | null> {
  // Scoped to the servers THIS voter can see. A deletion vote is a claim about media the
  // voter has access to; a copy on a restricted server they hold no grant for is not in
  // "any library" as far as they are concerned, and the vote button on the detail page is
  // gated on the same per-user availability.
  const visible = await getVisibleServerInstances(session);
  const [inPlex, inJellyfin] = await Promise.all([
    prisma.plexLibraryItem.findFirst({ where: { tmdbId, mediaType, serverInstance: { in: visible.plex } } }),
    prisma.jellyfinLibraryItem.findFirst({ where: { tmdbId, mediaType, serverInstance: { in: visible.jellyfin } } }),
  ]);
  if (!inPlex && !inJellyfin) return "not-in-library";

  // Bar any user who has ever requested this media (regardless of order),
  // including a title they filed on someone else's behalf. Earlier versions
  // only checked the oldest requester via orderBy; a co-requester could then
  // vote against a title they themselves had requested.
  const ownRequest = await prisma.mediaRequest.findFirst({
    where: {
      tmdbId,
      mediaType,
      OR: [{ requestedBy: session.user.id }, { filedBy: session.user.id }],
    },
    select: { id: true },
  });
  return ownRequest ? "own-request" : null;
}

export const POST = withAuth(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  if (!(await isFeatureEnabled("feature.page.votes"))) {
    return NextResponse.json({ error: t("apiUser.votes.disabled") }, { status: 403 });
  }

  const maint = await maintenanceGuard(session);
  if (maint) return maint;

  const rlRow = await prisma.setting.findUnique({ where: { key: "rateLimitRequests" } });
  const limit = parseRateLimit(rlRow?.value, 20);
  if (!checkRateLimit(`votes:${session.user.id}`, limit, 60 * 1000)) {
    return tooManyRequests(60, t("apiUser.common.tooManyRequestsLater"));
  }

  const parsed = await readJsonCapped<{ tmdbId?: unknown; mediaType?: unknown; reason?: unknown; _token?: unknown }>(req, 16384);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed;

  const fields = parseVoteBody(body);
  if (!fields.ok) return NextResponse.json({ error: t(fields.errorKey) }, { status: 400 });
  const { tmdbId, mediaType, reason } = fields;

  // typeof-guard BEFORE verifyRequestToken: readJsonCapped<T>'s generic is a
  // compile-time cast only, so a truthy non-string (`123`, `{}`) slipped past the
  // old `!_token` check and threw ERR_INVALID_ARG_TYPE out of Buffer.from(a, "hex")
  // as a 500 instead of this 403. Empty string is non-verifying and still 403s.
  if (typeof body._token !== "string" || !verifyRequestToken(body._token, tmdbId, mediaType, session.user.id)) {
    return NextResponse.json({ error: t("apiUser.common.invalidRequestToken") }, { status: 403 });
  }

  // Three-tier cached resolver (TmdbMediaCore -> details cache -> live TMDB),
  // the same one POST /api/requests uses — a vote almost always targets a title
  // the voter just viewed, so a live TMDB call per mutation was pure waste and
  // made a cold-cache TMDB outage 422 votes for titles the app already knows.
  const verified = await resolveMediaMeta(tmdbId, mediaType);
  if (!verified) {
    return NextResponse.json({ error: t("apiUser.common.tmdbUnverified") }, { status: 422 });
  }

  const refusal = await voteRefusal(session, tmdbId, mediaType);
  if (refusal === "not-in-library") {
    return NextResponse.json({ error: t("apiUser.votes.notInLibrary") }, { status: 422 });
  }
  if (refusal === "own-request") {
    return NextResponse.json({ error: t("apiUser.votes.ownRequest") }, { status: 403 });
  }

  const sanitizedReason = sanitizeOptional(reason);

  let vote: Awaited<ReturnType<typeof prisma.deletionVote.create>>;
  try {
    vote = await prisma.deletionVote.create({
      data: {
        tmdbId,
        mediaType,
        title: verified.title,
        posterPath: verified.posterPath,
        userId: session.user.id,
        reason: sanitizedReason ?? null,
      },
    });
  } catch (err) {
    if (isPrismaErrorCode(err, "P2002")) {
      return NextResponse.json({ error: t("apiUser.votes.alreadyVoted") }, { status: 409 });
    }
    throw err;
  }

  // The once-per-title admin alert, strictly AFTER the committed insert and
  // outside any transaction (guardrail 23; deletion-vote-threshold.ts).
  // The vote is saved: a failed alert read or claim must never turn it into a 500.
  await alertIfVoteThresholdReached({ tmdbId, mediaType, title: verified.title, posterPath: verified.posterPath ?? null })
    .catch((err) => console.error("[votes] threshold alert failed:", err instanceof Error ? err.message : String(err)));

  // Finish any alert a crash interrupted; throttled, never blocks or fails the vote.
  void sweepPendingVoteAlerts().catch((err) =>
    console.error("[votes] pending alert sweep failed:", err instanceof Error ? err.message : String(err)));

  return NextResponse.json(vote, { status: 201 });
});
