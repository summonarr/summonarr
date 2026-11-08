import { prisma } from "@/lib/prisma";
import { emitNotificationEvent } from "@/lib/notify-agents";
import { notifyAdminsNewIssue } from "@/lib/email";
import { notifyAdminsNewIssuePush } from "@/lib/push";
import { notifyAdminsNewIssueDiscord } from "@/lib/discord-notify";
import { emitSSE } from "@/lib/sse-emitter";
import { resolveTvdbIdFromTmdbId } from "@/lib/arr";
import { resolveMediaMeta } from "@/lib/request-meta";
import { sanitizeOptional } from "@/lib/sanitize";
import { loadPlaybackContext } from "@/lib/issue-playback-context-data";
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
      // The new issue — or the reporter's identical one still open, unchanged.
      issue: Issue;
      // The admin fan-out (outbound agents, email, push, Discord); a no-op for
      // an issue that was already open. Never throws.
      notify: () => Promise<void>;
    }
  | { ok: false; status: 400 | 422; error: string };

type IssueScopeValue = (typeof VALID_ISSUE_SCOPES)[number];

/** A filing whose every field passed validation, typed as what it is. */
interface ValidatedIssue {
  mediaType: "MOVIE" | "TV";
  tmdbId: number;
  issueType: IssueTypeValue;
  scope: IssueScopeValue;
  /** Set only for a SEASON/EPISODE scope. */
  seasonNumber: number | null;
  /** Set only for an EPISODE scope. */
  episodeNumber: number | null;
  note: string | null;
}

type Refusal = { ok: false; status: 400 | 422; error: string };
const refuse = (status: 400 | 422, error: string): Refusal => ({ ok: false, status, error });

const isIssueType = (v: unknown): v is IssueTypeValue => VALID_ISSUE_TYPES.includes(v as IssueTypeValue);
const isIssueScope = (v: unknown): v is IssueScopeValue => VALID_ISSUE_SCOPES.includes(v as IssueScopeValue);

/** A season or episode number: a positive integer, at most MAX_SEASON_EPISODE. */
function numberField(value: unknown): "missing" | "tooLarge" | number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) return "missing";
  return value > MAX_SEASON_EPISODE ? "tooLarge" : value;
}

/**
 * Validate a filing and narrow it to its types. A movie has no seasons, so its
 * scope is always FULL whatever was sent, and it never stores a season or
 * episode (a movie issue carrying S1E3 matched no playback context and slipped
 * the duplicate check).
 */
export function validateIssueInput(input: IssueInput, t: Translator): { ok: true; value: ValidatedIssue } | Refusal {
  // tvdbId is intentionally NOT an input: a client could pair a library title's
  // tmdbId with a DIFFERENT show's tvdbId, so the admin Sonarr grab/search
  // downloads the wrong series. It is resolved from the verified tmdbId later.
  const { mediaType, tmdbId, issueType, note } = input;

  if (!mediaType || !tmdbId || !issueType) return refuse(400, t("apiUser.issues.fieldsRequired"));
  if (mediaType !== "MOVIE" && mediaType !== "TV") return refuse(400, t("apiUser.common.mediaTypeInvalid"));
  if (typeof tmdbId !== "number" || !Number.isInteger(tmdbId) || tmdbId <= 0) return refuse(400, t("apiUser.common.tmdbIdPositive"));
  if (!isIssueType(issueType)) {
    return refuse(400, t("apiUser.issues.issueTypeOneOf", { values: VALID_ISSUE_TYPES.join(", ") }));
  }

  const sentScope = input.scope ?? "FULL";
  if (!isIssueScope(sentScope)) {
    return refuse(400, t("apiUser.issues.scopeOneOf", { values: VALID_ISSUE_SCOPES.join(", ") }));
  }
  const scope: IssueScopeValue = mediaType === "MOVIE" ? "FULL" : sentScope;

  if (note !== undefined && (typeof note !== "string" || note.length > MAX_ISSUE_NOTE_LENGTH)) {
    return refuse(400, t("apiUser.issues.noteTooLong"));
  }

  let seasonNumber: number | null = null;
  let episodeNumber: number | null = null;
  if (scope === "SEASON" || scope === "EPISODE") {
    const season = numberField(input.seasonNumber);
    if (season === "missing") return refuse(400, t("apiUser.issues.seasonRequired"));
    if (season === "tooLarge") return refuse(400, t("apiUser.issues.seasonTooLarge", { max: MAX_SEASON_EPISODE }));
    seasonNumber = season;
  }
  if (scope === "EPISODE") {
    const episode = numberField(input.episodeNumber);
    if (episode === "missing") return refuse(400, t("apiUser.issues.episodeRequired"));
    if (episode === "tooLarge") return refuse(400, t("apiUser.issues.episodeTooLarge", { max: MAX_SEASON_EPISODE }));
    episodeNumber = episode;
  }

  return {
    ok: true,
    value: { mediaType, tmdbId, issueType, scope, seasonNumber, episodeNumber, note: sanitizeOptional(note) ?? null },
  };
}

/**
 * Issues presuppose the title is in the library — every type (bad video, wrong
 * audio, missing subs, wrong match) is about media you HAVE. Gate on a Plex or
 * Jellyfin library hit so the API can't be scripted into issue records for
 * titles that aren't available (the UI only surfaces "report issue" on
 * available media).
 *
 * Scoped to the servers THIS reporter can see: a copy on a restricted server
 * they hold no grant for isn't media they HAVE, so it must not open the gate.
 * The converse is what makes the check consistent with the button — the detail
 * page renders "report issue" off the same per-user availability.
 */
async function inReportersLibrary(session: SummonarrSession, tmdbId: number, mediaType: "MOVIE" | "TV"): Promise<boolean> {
  const visible = await getVisibleServerInstances(session);
  const [plexHit, jellyfinHit] = await Promise.all([
    prisma.plexLibraryItem.findFirst({
      where: { tmdbId, mediaType, serverInstance: { in: visible.plex } },
      select: { tmdbId: true },
    }),
    prisma.jellyfinLibraryItem.findFirst({
      where: { tmdbId, mediaType, serverInstance: { in: visible.jellyfin } },
      select: { tmdbId: true },
    }),
  ]);
  return plexHit !== null || jellyfinHit !== null;
}

/**
 * Store the filing, or answer the reporter's identical one still open (a double
 * submit, a client or Discord retry): no second row, no second admin fan-out.
 * The note is part of "the same": a re-report carrying a different note is new
 * information and is filed, never dropped. The check and the insert run under a
 * per-reporter lock (two-key form, 4630 + hashtext(reporter)), so two identical
 * filings racing can't both pass the read. Every network call happened before:
 * nothing slow runs while the lock is held. Its queries run one at a time
 * (guardrail 23c).
 */
async function persistIssue(
  reportedBy: string,
  issue: ValidatedIssue,
  extra: { tvdbId: number | null; title: string; posterPath: string | null; playbackContext: Awaited<ReturnType<typeof loadPlaybackContext>> },
): Promise<{ issue: Issue; created: boolean }> {
  const same = {
    reportedBy,
    tmdbId: issue.tmdbId,
    mediaType: issue.mediaType,
    issueType: issue.issueType,
    scope: issue.scope,
    seasonNumber: issue.seasonNumber,
    episodeNumber: issue.episodeNumber,
    note: issue.note,
  };
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(4630, hashtext(${reportedBy}))`;
    const duplicate = await tx.issue.findFirst({
      where: { ...same, status: { in: ["OPEN", "IN_PROGRESS"] } },
      orderBy: { createdAt: "desc" },
    });
    if (duplicate) return { issue: duplicate, created: false };
    const created = await tx.issue.create({
      data: {
        ...same,
        tvdbId: extra.tvdbId,
        title: extra.title,
        posterPath: extra.posterPath,
        ...(extra.playbackContext ? { playbackContext: extra.playbackContext } : {}),
      },
    });
    return { issue: created, created: true };
  });
}

/** The admin fan-out for a new issue (outbound agents, email, push, Discord). Never throws. */
function adminFanOut(session: SummonarrSession, issue: Issue, filing: ValidatedIssue, verified: { title: string; posterPath: string | null }) {
  const reportedBy = session.user.name ?? session.user.email ?? session.user.id;
  const { mediaType: mt, tmdbId, issueType, note } = filing;
  return async () => {
    emitNotificationEvent({
      event: "issue.created",
      media: { type: mt, tmdbId, title: verified.title, posterPath: verified.posterPath ?? null },
      issue: { id: issue.id, type: issueType },
      actor: { name: reportedBy },
      text: note,
    });
    await Promise.allSettled([
      notifyAdminsNewIssue({ title: verified.title, mediaType: mt, tmdbId, issueType, reportedBy, note, posterPath: verified.posterPath, issueId: issue.id, excludeUserId: session.user.id }),
      notifyAdminsNewIssuePush({ title: verified.title, tmdbId, mediaType: mt, issueType, reportedBy, issueId: issue.id, excludeUserId: session.user.id }),
      notifyAdminsNewIssueDiscord({ issueId: issue.id, title: verified.title, mediaType: mt, tmdbId, issueType, reportedBy, note, posterPath: verified.posterPath }),
    ]);
  };
}

export async function createIssue(
  session: SummonarrSession,
  input: IssueInput,
  t: Translator,
): Promise<CreateIssueResult> {
  const validated = validateIssueInput(input, t);
  if (!validated.ok) return validated;
  const filing = validated.value;
  const { tmdbId, mediaType: mt } = filing;

  // Look the title up via TMDB (cached) so the stored title/poster come from TMDB,
  // not from the client. See votes/route.ts for how the cache tiers work.
  const verified = await resolveMediaMeta(tmdbId, mt);
  if (!verified) return refuse(422, t("apiUser.common.tmdbUnverified"));
  if (!(await inReportersLibrary(session, tmdbId, mt))) return refuse(422, t("apiUser.issues.notInLibrary"));

  // Past the library gate only, so a refused report costs no Sonarr lookup.
  // tvdbId is resolved server-side from the verified tmdbId for TV — never a
  // client-chosen id. May be null if resolution fails: the admin grab/search
  // paths resolve on demand and fall back gracefully. The playback context is
  // best effort (never throws): what the reporter's last play looked like.
  const [resolvedTvdbId, playbackContext] = await Promise.all([
    mt === "TV" ? resolveTvdbIdFromTmdbId(tmdbId) : Promise.resolve(null),
    loadPlaybackContext(
      session.user.id,
      { tmdbId, mediaType: mt },
      { scope: filing.scope, seasonNumber: filing.seasonNumber, episodeNumber: filing.episodeNumber },
      new Date(),
    ),
  ]);

  const { issue, created } = await persistIssue(session.user.id, filing, {
    tvdbId: resolvedTvdbId, title: verified.title, posterPath: verified.posterPath, playbackContext,
  });
  if (!created) return { ok: true, issue, notify: async () => {} };

  emitSSE({ type: "issue:new", issueId: issue.id, userId: session.user.id });
  return { ok: true, issue, notify: adminFanOut(session, issue, filing, verified) };
}
