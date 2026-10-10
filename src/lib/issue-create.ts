import { prisma } from "@/lib/prisma";
import { emitNotificationEvent } from "@/lib/notify-agents";
import { notifyAdminsNewIssue } from "@/lib/email";
import { notifyAdminsNewIssuePush } from "@/lib/push";
import { notifyAdminsNewIssueDiscord } from "@/lib/discord-notify";
import { emitSSE } from "@/lib/sse-emitter";
import { resolveTvdbIdFromTmdbId } from "@/lib/arr";
import { resolveMediaMeta } from "@/lib/request-meta";
import { sanitizeOptional } from "@/lib/sanitize";
import { getVisibleServerInstances } from "@/lib/media-visibility";
import type { SummonarrSession } from "@/lib/api-auth";
import type { Translator } from "@/lib/i18n/translate";
import type { Issue } from "@/generated/prisma";

// Filing an issue — POST /api/issues minus its HTTP shell (feature flag,
// maintenance, rate limit, body parse), shared with Discord's /issue so the two
// can't drift on validation, the library gate or the admin fan-out. The caller
// runs the pre-body gates and decides how to defer `notify` (the route hands it
// to after(); Discord, already detached from its request, just runs it).

export const VALID_ISSUE_TYPES = ["BAD_VIDEO", "WRONG_AUDIO", "MISSING_SUBTITLES", "WRONG_MATCH", "OTHER"] as const;
export type IssueTypeValue = (typeof VALID_ISSUE_TYPES)[number];
export const VALID_ISSUE_SCOPES = ["FULL", "SEASON", "EPISODE"] as const;
// Issue.seasonNumber/episodeNumber are INT4. Without a ceiling an out-of-range
// value clears Number.isInteger and then throws out of prisma.issue.create.
export const MAX_SEASON_EPISODE = 10_000;
export const MAX_ISSUE_NOTE_LENGTH = 1000;

export interface IssueInput {
  mediaType?: unknown;
  tmdbId?: unknown;
  issueType?: unknown;
  scope?: unknown;
  seasonNumber?: unknown;
  episodeNumber?: unknown;
  note?: unknown;
}

export type CreateIssueResult =
  | {
      ok: true;
      issue: Issue;
      // The admin fan-out (outbound agents, email, push, Discord). Never throws.
      notify: () => Promise<void>;
    }
  | { ok: false; status: 400 | 422; error: string };

export async function createIssue(
  session: SummonarrSession,
  input: IssueInput,
  t: Translator,
): Promise<CreateIssueResult> {
  const refuse = (status: 400 | 422, error: string): CreateIssueResult => ({ ok: false, status, error });
  // tvdbId is intentionally NOT an input: a client could pair a library title's
  // tmdbId with a DIFFERENT show's tvdbId, so the admin Sonarr grab/search
  // downloads the wrong series. It is resolved from the verified tmdbId below.
  const { mediaType, tmdbId, issueType, scope, seasonNumber, episodeNumber, note } = input;

  if (!mediaType || !tmdbId || !issueType) return refuse(400, t("apiUser.issues.fieldsRequired"));
  if (mediaType !== "MOVIE" && mediaType !== "TV") return refuse(400, t("apiUser.common.mediaTypeInvalid"));
  if (typeof tmdbId !== "number" || !Number.isInteger(tmdbId) || tmdbId <= 0) return refuse(400, t("apiUser.common.tmdbIdPositive"));
  if (!VALID_ISSUE_TYPES.includes(issueType as IssueTypeValue)) {
    return refuse(400, t("apiUser.issues.issueTypeOneOf", { values: VALID_ISSUE_TYPES.join(", ") }));
  }

  const resolvedScope = (scope ?? "FULL") as (typeof VALID_ISSUE_SCOPES)[number];
  if (!VALID_ISSUE_SCOPES.includes(resolvedScope)) {
    return refuse(400, t("apiUser.issues.scopeOneOf", { values: VALID_ISSUE_SCOPES.join(", ") }));
  }

  if (note !== undefined && (typeof note !== "string" || note.length > MAX_ISSUE_NOTE_LENGTH)) {
    return refuse(400, t("apiUser.issues.noteTooLong"));
  }
  const sanitizedNote = sanitizeOptional(note as string | undefined);

  if (resolvedScope === "SEASON" || resolvedScope === "EPISODE") {
    if (!Number.isInteger(seasonNumber) || (seasonNumber as number) < 1) return refuse(400, t("apiUser.issues.seasonRequired"));
    if ((seasonNumber as number) > MAX_SEASON_EPISODE) {
      return refuse(400, t("apiUser.issues.seasonTooLarge", { max: MAX_SEASON_EPISODE }));
    }
  }
  if (resolvedScope === "EPISODE") {
    if (!Number.isInteger(episodeNumber) || (episodeNumber as number) < 1) return refuse(400, t("apiUser.issues.episodeRequired"));
    if ((episodeNumber as number) > MAX_SEASON_EPISODE) {
      return refuse(400, t("apiUser.issues.episodeTooLarge", { max: MAX_SEASON_EPISODE }));
    }
  }

  // Look the title up via TMDB (cached) so the stored title/poster come from TMDB,
  // not from the client. See votes/route.ts for how the cache tiers work.
  const mt = mediaType as "MOVIE" | "TV";
  const verified = await resolveMediaMeta(tmdbId, mt);
  if (!verified) return refuse(422, t("apiUser.common.tmdbUnverified"));

  // Resolve tvdbId server-side from the verified tmdbId for TV. May be null if
  // resolution fails — the admin grab/search paths resolve on demand and fall back
  // gracefully, so a null here is safe (never a client-chosen id).
  const resolvedTvdbId = mt === "TV" ? await resolveTvdbIdFromTmdbId(tmdbId) : null;

  // Issues presuppose the title is in the library — every type (bad video, wrong
  // audio, missing subs, wrong match) is about media you HAVE. Gate on a Plex or
  // Jellyfin library hit so the API can't be scripted into issue records for titles
  // that aren't available (the UI only surfaces "report issue" on available media).
  //
  // Scoped to the servers THIS reporter can see: a copy on a restricted server they hold
  // no grant for isn't media they HAVE, so it must not open the gate. The converse is what
  // makes the check consistent with the button — the detail page renders "report issue" off
  // the same per-user availability.
  const visible = await getVisibleServerInstances(session);
  const [plexHit, jellyfinHit] = await Promise.all([
    prisma.plexLibraryItem.findFirst({
      where: { tmdbId, mediaType: mt, serverInstance: { in: visible.plex } },
      select: { tmdbId: true },
    }),
    prisma.jellyfinLibraryItem.findFirst({
      where: { tmdbId, mediaType: mt, serverInstance: { in: visible.jellyfin } },
      select: { tmdbId: true },
    }),
  ]);
  if (!plexHit && !jellyfinHit) return refuse(422, t("apiUser.issues.notInLibrary"));

  const issue = await prisma.issue.create({
    data: {
      reportedBy: session.user.id,
      mediaType: mt,
      tmdbId,
      tvdbId: resolvedTvdbId,
      title: verified.title,
      posterPath: verified.posterPath,
      issueType: issueType as IssueTypeValue,
      scope: resolvedScope,
      seasonNumber: resolvedScope !== "FULL" ? ((seasonNumber as number | undefined) ?? null) : null,
      episodeNumber: resolvedScope === "EPISODE" ? ((episodeNumber as number | undefined) ?? null) : null,
      note: sanitizedNote ?? null,
    },
  });

  emitSSE({ type: "issue:new", issueId: issue.id, userId: session.user.id });
  const reportedBy = session.user.name ?? session.user.email ?? session.user.id;
  const notify = async () => {
    emitNotificationEvent({
      event: "issue.created",
      media: { type: mt, tmdbId, title: verified.title, posterPath: verified.posterPath ?? null },
      issue: { id: issue.id, type: issueType as string },
      actor: { name: reportedBy },
      text: sanitizedNote ?? null,
    });
    await Promise.allSettled([
      notifyAdminsNewIssue({ title: verified.title, mediaType: mt, tmdbId, issueType: issueType as string, reportedBy, note: sanitizedNote ?? null, posterPath: verified.posterPath, issueId: issue.id, excludeUserId: session.user.id }),
      notifyAdminsNewIssuePush({ title: verified.title, tmdbId, mediaType: mt, issueType: issueType as string, reportedBy, issueId: issue.id, excludeUserId: session.user.id }),
      notifyAdminsNewIssueDiscord({ issueId: issue.id, title: verified.title, mediaType: mt, tmdbId, issueType: issueType as string, reportedBy, note: sanitizedNote ?? null, posterPath: verified.posterPath }),
    ]);
  };
  return { ok: true, issue, notify };
}
