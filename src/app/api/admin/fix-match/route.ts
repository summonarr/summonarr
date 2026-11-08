import { NextResponse } from "next/server";
import { readJsonCapped } from "@/lib/body-size";
import { withIssueAdmin } from "@/lib/api-auth";
import { isTmdbIdInRange } from "@/lib/tmdb-id";
import { auditContext } from "@/lib/audit";
import { checkRateLimit } from "@/lib/rate-limit";
import { awaitFixMatchJob, FixMatchError, findRunningFixMatchJob, fixMatchJobKey, startFixMatchJob } from "@/lib/fix-match-jobs";
import { findOverlappingFixMatchJob, noteFixMatchScope } from "@/lib/fix-match-conflicts";
import { closeIssueAfterFix, libraryTitleFor, runFixMatch, type FixMatchActor, type FixMatchInput, type IssueClose } from "@/lib/fix-match-run";
import { DEFAULT_MEDIA_INSTANCE, isValidMediaInstanceSlug } from "@/lib/media-instances";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import type { Translator } from "@/lib/i18n/translate";
import { maintenanceGuard } from "@/lib/maintenance";
import { sanitizeOptional } from "@/lib/sanitize";
import { findMatchFlag, readLibraryMatchReport } from "@/lib/library-match-data";

// The fix-match POST: validates the body, then runs the remap through the job
// registry (guardrail 37a) — awaited for the synchronous contract the iOS app
// pins, or answered at once with a job id for `async: true`. The remap itself
// lives in fix-match-run.ts and the modules it calls.

type FixMatchBody = {
  server:         "plex" | "jellyfin";
  tmdbId:         number;
  mediaType:      "MOVIE" | "TV";
  correctTmdbId:  number;

  canonicalGuid?: string;
  // Run the remap as a background job and answer 202 + jobId at once (guardrail
  // 37a); the caller polls /api/admin/fix-match/status. Absent/false keeps the
  // synchronous contract the iOS client pins.
  async?: boolean;
  // Multi-server support: which configured server's library row to remap.
  // Optional + defaults to the default server ("") so an existing caller that
  // doesn't send it yet keeps targeting the only server that existed before
  // this field was added.
  serverInstance?: string;
  // Item mode: remap ONE server item (Plex ratingKey / Jellyfin item id) that
  // the library match check flagged, instead of every copy holding `tmdbId`.
  // The item's current id, media type and path come from the stored report —
  // `tmdbId` is ignored, and an item the check didn't flag is refused.
  itemKey?: string;
  // Background title mode only: the WRONG_MATCH issue this fix answers (the
  // issue dialog). The job closes it when the remap succeeds, with a note
  // naming `issueTitle` (the title picked, display only).
  issueId?: string;
  issueTitle?: string;
};

// Cuid-shaped; the issue itself is read (and bound to the title) at close time.
const ISSUE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ISSUE_TITLE_MAX = 200;

const badRequest = (error: string) => NextResponse.json({ error }, { status: 400 });

// The body's fields, checked. A NextResponse is the 400 to answer.
function validateBody(body: FixMatchBody, t: Translator): FixMatchInput | NextResponse {
  const { server, tmdbId, mediaType, correctTmdbId, canonicalGuid } = body;
  if (server !== "plex" && server !== "jellyfin") return badRequest(t("apiAdmin.common.serverPlexOrJellyfin"));
  if (mediaType !== "MOVIE" && mediaType !== "TV") return badRequest(t("apiAdmin.fixMatch.mediaTypeQuoted"));
  const itemMode = body.itemKey !== undefined;
  if (!itemMode && !isTmdbIdInRange(tmdbId)) return badRequest(t("apiAdmin.common.tmdbIdPositive"));
  if (!isTmdbIdInRange(correctTmdbId)) return badRequest(t("apiAdmin.fixMatch.correctTmdbIdPositive"));
  if (!itemMode && tmdbId === correctTmdbId) return badRequest(t("apiAdmin.fixMatch.sameIds"));
  if (canonicalGuid != null && typeof canonicalGuid !== "string") return badRequest(t("apiAdmin.fixMatch.canonicalGuidString"));
  if (body.serverInstance !== undefined && !isValidMediaInstanceSlug(body.serverInstance)) {
    return badRequest(t("apiAdmin.common.invalidServerInstance", { slug: String(body.serverInstance) }));
  }
  return { server, tmdbId, mediaType, correctTmdbId, canonicalGuid, serverInstance: body.serverInstance ?? DEFAULT_MEDIA_INSTANCE };
}

// Item mode (guardrail 37e): the key only NAMES an item the last match check
// flagged on this server; everything else about it is read from that stored
// flag, never the body. Also returns the flag's title for the job tray.
async function resolveItemMode(
  input: FixMatchInput, itemKey: unknown, t: Translator,
): Promise<{ input: FixMatchInput; flaggedTitle: string | null } | NextResponse> {
  const shaped = typeof itemKey === "string" && (input.server === "plex" ? /^\d{1,12}$/ : /^[0-9a-f-]{32,36}$/i).test(itemKey);
  if (!shaped) return badRequest(t("apiAdmin.fixMatch.itemKeyInvalid"));
  const flag = findMatchFlag(await readLibraryMatchReport(), input.server, input.serverInstance, itemKey);
  if (!flag || flag.mediaType !== input.mediaType) {
    return NextResponse.json({ error: t("apiAdmin.fixMatch.itemNotFlagged") }, { status: 404 });
  }
  if (flag.serverTmdbId === input.correctTmdbId) return badRequest(t("apiAdmin.fixMatch.sameIds"));
  return {
    input: { ...input, tmdbId: flag.serverTmdbId ?? 0, mediaType: flag.mediaType, itemKey, itemPath: flag.path, itemArr: flag.arr },
    flaggedTitle: flag.title ? `${flag.title}${flag.year ? ` (${flag.year})` : ""}` : null,
  };
}

// The issue a background title-mode fix answers, checked; null without one.
// Closing an issue is an issue write: refused during maintenance exactly like
// the PATCH, while the fix itself still runs.
async function readIssueClose(
  body: FixMatchBody, itemMode: boolean, session: Parameters<typeof maintenanceGuard>[0], t: Translator,
): Promise<IssueClose | null | NextResponse> {
  if (body.issueId === undefined) return null;
  if (
    itemMode || typeof body.issueId !== "string" || !ISSUE_ID_RE.test(body.issueId) ||
    (body.issueTitle !== undefined && typeof body.issueTitle !== "string")
  ) {
    return badRequest(t("apiAdmin.common.invalidBody"));
  }
  return {
    issueId: body.issueId,
    title: sanitizeOptional(body.issueTitle)?.slice(0, ISSUE_TITLE_MAX) ?? null,
    allowed: (await maintenanceGuard(session)) === null,
  };
}

// A job under another key is rewriting the same server item (an admin
// correcting a wrong pick while the first fix still polls): refused, never run
// beside it — two remaps of one item undo each other's match on the server.
const itemBusy = (t: Translator) => NextResponse.json({ error: t("apiAdmin.fixMatch.itemBusy") }, { status: 409 });

const scopeOf = (input: FixMatchInput) => ({
  server: input.server, serverInstance: input.serverInstance, mediaType: input.mediaType, tmdbId: input.tmdbId, itemKey: input.itemKey,
});

// withIssueAdmin, not withAdmin: an ISSUE_ADMIN may fix a wrong match to
// resolve a reported issue without holding full admin rights.
export const POST = withIssueAdmin(async (request, _ctx, session) => {
  const t = translatorForRequest(request);
  // fix-match runs ~60s of Plex/Jellyfin remap calls plus DB writes — without
  // a rate limit, an admin loop (intentional or scripted) can saturate the
  // upstream servers and pile up partial two-phase commits (remote rewrite
  // succeeds, DB tx fails). 10/min/admin matches the broader admin-write cap.
  if (!checkRateLimit(`fix-match:${session.user.id}`, 10, 60_000)) {
    return NextResponse.json(
      { error: t("apiAdmin.fixMatch.tooMany") },
      { status: 429 },
    );
  }

  const parsed = await readJsonCapped<FixMatchBody>(request, 16384);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed;

  const checked = validateBody(body, t);
  if (checked instanceof NextResponse) return checked;
  let input = checked;
  // Shown in the job tray; the match check's flag already carries a title.
  let flaggedTitle: string | null = null;
  const itemMode = body.itemKey !== undefined;
  if (itemMode) {
    const resolved = await resolveItemMode(input, body.itemKey, t);
    if (resolved instanceof NextResponse) return resolved;
    ({ input, flaggedTitle } = resolved);
  }
  const actor: FixMatchActor = {
    userId: session.user.id, userName: session.user.name ?? session.user.email, ctx: auditContext(request, session),
  };

  if (body.async === true) {
    const issueClose = await readIssueClose(body, itemMode, session, t);
    if (issueClose instanceof NextResponse) return issueClose;
    return startInBackground(input, actor, issueClose, flaggedTitle, t);
  }
  return runSynchronously(input, actor, flaggedTitle, t);
});

// Background mode (guardrail 37a): a series remap waits on the media server
// for minutes — longer than a reverse proxy keeps one request open — so the
// browser polls instead of holding the request. An identical job already
// running is returned as-is, never started twice.
async function startInBackground(
  input: FixMatchInput, actor: FixMatchActor, issueClose: IssueClose | null, flaggedTitle: string | null, t: Translator,
): Promise<NextResponse> {
  const key = fixMatchJobKey(input);
  // `joined: true` tells the client its submission attached to an
  // already-running identical remap — whose candidate selection may differ.
  // A joined job closes this caller's issue too, once it succeeds.
  const joinedAnswer = (existing: { id: string; status: string }) => {
    if (issueClose) {
      void awaitFixMatchJob(existing.id).then((settled) =>
        settled?.status === "done" ? closeIssueAfterFix(issueClose, input, actor, t) : false);
    }
    return NextResponse.json({ ok: true, jobId: existing.id, status: existing.status, joined: true }, { status: 202 });
  };
  const existing = findRunningFixMatchJob(key);
  if (existing) return joinedAnswer(existing);
  try {
    const title = flaggedTitle ?? await libraryTitleFor(input);
    // Re-checked after the await, synchronously with the start below, so a
    // job started meanwhile is joined (and closes the issue) as well.
    const raced = findRunningFixMatchJob(key);
    if (raced) return joinedAnswer(raced);
    if (findOverlappingFixMatchJob(key, scopeOf(input))) return itemBusy(t);
    const job = startFixMatchJob(key, async (report) => {
      const result = await runFixMatch(input, actor, { background: true, report }, t);
      // Closed inside the job, before it reads as done, so the poll that
      // sees "done" also learns whether the issue closed.
      return issueClose ? { ...result, issueResolved: await closeIssueAfterFix(issueClose, input, actor, t) } : result;
    }, Date.now(), t, title);
    noteFixMatchScope(job.id, key, scopeOf(input));
    return NextResponse.json({ ok: true, jobId: job.id, status: job.status }, { status: 202 });
  } catch (err) {
    // The registry's concurrent-running cap (429) — map like the sync branch.
    if (err instanceof FixMatchError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}

// The synchronous contract the iOS app pins: the same body and status as
// ever, with the shorter confirmation windows. The remap still runs through
// the registry, so an identical remap already running (a background job or
// another synchronous call) is awaited instead of driven a second time
// against the same item, and the run counts against the running cap.
async function runSynchronously(
  input: FixMatchInput, actor: FixMatchActor, flaggedTitle: string | null, t: Translator,
): Promise<NextResponse> {
  const key = fixMatchJobKey(input);
  let job;
  try {
    const title = flaggedTitle ?? await libraryTitleFor(input);
    if (findOverlappingFixMatchJob(key, scopeOf(input))) return itemBusy(t);
    job = startFixMatchJob(key, (report) => runFixMatch(input, actor, { background: false, report }, t), Date.now(), t, title);
    noteFixMatchScope(job.id, key, scopeOf(input));
  } catch (err) {
    // The registry's queue cap (429), mapped like the async branch.
    if (err instanceof FixMatchError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
  const settled = await awaitFixMatchJob(job.id);
  if (settled?.status === "done" && settled.result) {
    // A joined background job may carry its issue's flag; this body never does.
    const { issueResolved: _issueResolved, ...syncResult } = settled.result;
    return NextResponse.json(syncResult);
  }
  // runFixMatch maps every failure to a client-safe FixMatchError; the
  // registry stores its message and status (or the generic 502 for anything
  // unmapped).
  return NextResponse.json(
    { error: settled?.error ?? t("apiAdmin.fixMatch.failed") },
    { status: settled?.errorStatus ?? 502 },
  );
}
