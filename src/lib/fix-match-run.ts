import { prisma } from "@/lib/prisma";
import { FixMatchError, type FixMatchJobResult } from "@/lib/fix-match-jobs";
import { DEFAULT_MEDIA_INSTANCE, mediaInstanceLabel } from "@/lib/media-instances";
import type { Translator } from "@/lib/i18n/translate";
import { dropCandidatesFor, dropCandidatesForTitles } from "@/lib/fix-match-candidate-cache";
import { cachedTmdbTitle } from "@/lib/fix-match-shared";
import { resolveIssueAfterAction } from "@/lib/issue-transitions";
import { logAudit } from "@/lib/audit";
import { PlexUnmatchedError } from "@/lib/fix-match-plex";
import { FixMatchDiagnosticError } from "@/lib/fix-match-remote";
import {
  runItemMode,
  runJellyfinTitleMode,
  runPlexTitleMode,
  type FixMatchActor,
  type FixMatchInput,
  type RunOpts,
  type RunState,
} from "@/lib/fix-match-apply";

export type { FixMatchActor, FixMatchInput } from "@/lib/fix-match-apply";

// The whole remap — remote rewrite, cache-row transaction, audit, episode
// re-cache — as one unit that resolves to the client-facing result or throws a
// FixMatchError carrying the client-safe message + HTTP status. The POST
// handler runs it through the job registry either way (guardrail 37a) and
// either awaits the job (the synchronous contract) or answers with its id; both
// paths see exactly the same outcomes.
export async function runFixMatch(input: FixMatchInput, actor: FixMatchActor, opts: RunOpts, t: Translator): Promise<FixMatchJobResult> {
  const state: RunState = { remoteRemapped: false, plexKeysTouched: [] };
  try {
    return await runFixMatchOnce(input, actor, opts, t, state);
  } finally {
    // Whatever happened, Plex's answer for the items this run touched may have
    // changed — a cached candidate list would describe them as they were
    // before the attempt. Other titles' lists stay. Only Plex lists are
    // cached, but a Plex list also shows its title's Jellyfin path, so a
    // Jellyfin run drops the lists of the title it moved from and the one it
    // moved to (an unmatched item's "from" is 0 and names no list).
    if (input.server === "plex") dropCandidatesFor(input.serverInstance, state.plexKeysTouched);
    else dropCandidatesForTitles(input.mediaType, [input.tmdbId, input.correctTmdbId]);
  }
}

async function runFixMatchOnce(
  input: FixMatchInput, actor: FixMatchActor, opts: RunOpts, t: Translator, state: RunState,
): Promise<FixMatchJobResult> {
  try {
    if (input.itemKey !== undefined) return await runItemMode(input, input.itemKey, actor, opts, t, state);
    return input.server === "plex"
      ? await runPlexTitleMode(input, actor, opts, t, state)
      : await runJellyfinTitleMode(input, actor, opts, t, state);
  } catch (err) {
    if (err instanceof FixMatchError) throw err;
    // Log the real detail server-side only — the message can carry the
    // configured Plex/Jellyfin server URL, internal paths, or upstream
    // response bodies (guardrail 37a).
    const errClass = err instanceof Error ? err.constructor.name : "Error";
    console.error("[fix-match]", `${mediaInstanceLabel(input.server, input.serverInstance)} error (${errClass})`, err instanceof Error ? err.message : err);
    if (state.remoteRemapped && !(err instanceof PlexUnmatchedError)) auditRemoteOnlyRemap(input, actor);
    throw clientFailure(err, input, state, t);
  }
}

// The remote remap DID happen but the cache phase failed. Audited anyway
// (swallowing variant, guardrail 26) so a change the library server now carries
// is not invisible to the audit log.
function auditRemoteOnlyRemap(input: FixMatchInput, actor: FixMatchActor): void {
  const { server, tmdbId, mediaType, correctTmdbId, serverInstance } = input;
  console.warn("[fix-match]", `${mediaInstanceLabel(server, serverInstance)} remapped remotely but the DB update failed for tmdb:${tmdbId} → ${correctTmdbId}; cache is out of sync until a re-sync runs`);
  void logAudit({
    ...actor.ctx,
    userId: actor.userId, userName: actor.userName, action: "FIX_MATCH", target: `tmdb:${tmdbId}`,
    details: { type: "fix-match", source: server, fromTmdbId: tmdbId, toTmdbId: correctTmdbId, mediaType, serverInstance, dbUpdated: false },
  });
}

/** What the caller is told about a failed run: a message that is safe to show, and the status. */
export function clientFailure(err: unknown, input: FixMatchInput, state: RunState, t: Translator): FixMatchError {
  const { server, correctTmdbId, serverInstance } = input;
  // The unmatch landed but no re-match was confirmed: the item is UNMATCHED
  // in Plex, not unchanged, and drops out of availability on the next sync.
  if (err instanceof PlexUnmatchedError) {
    return new FixMatchError(t("apiAdmin.fixMatch.plexUnmatched", { tmdbId: correctTmdbId }), 502);
  }
  // The remote remap already committed, so the failure is in the DB phase: the
  // library server points at the corrected id but the cache still references
  // the old one. Name the instance — on a multi-server deployment the operator
  // needs to know WHICH server to re-sync.
  if (state.remoteRemapped) {
    const base = server === "plex" ? "Plex" : "Jellyfin";
    const serverName = serverInstance === DEFAULT_MEDIA_INSTANCE ? base : `${base} (${serverInstance})`;
    return new FixMatchError(t("apiAdmin.fixMatch.cacheUpdateFailed", { server: serverName, tmdbId: correctTmdbId }), 502);
  }
  // The remote helper said what it saw and what to do about it.
  if (err instanceof FixMatchDiagnosticError) return new FixMatchError(t(err.key, err.vars), 502);
  return new FixMatchError(t("apiAdmin.fixMatch.failed"), 502);
}

// "Title (Year)" of the row being remapped, for the job tray only — best effort,
// never a reason to refuse the job.
export async function libraryTitleFor(input: FixMatchInput): Promise<string | null> {
  try {
    const where = { tmdbId: input.tmdbId, mediaType: input.mediaType, serverInstance: input.serverInstance };
    const row = input.server === "plex"
      ? await prisma.plexLibraryItem.findFirst({ where, select: { title: true, year: true } })
      : await prisma.jellyfinLibraryItem.findFirst({ where, select: { title: true, year: true } });
    return row?.title ? `${row.title}${row.year ? ` (${row.year})` : ""}` : null;
  } catch {
    return null;
  }
}

// The PATCH route's resolution cap.
const RESOLUTION_MAX = 1000;

// The issue a background fix answers. `allowed` is false when closing it is
// refused (maintenance, like the PATCH); the fix itself still runs.
export type IssueClose = { issueId: string; title: string | null; allowed: boolean };

// Closes the issue a successful fix answers, from the job itself, so it no
// longer depends on the browser staying until the remap ends. The note is in
// the starting request's language — what the dialog used to PATCH. Never
// throws: the remap has already landed.
export async function closeIssueAfterFix(close: IssueClose, input: FixMatchInput, actor: FixMatchActor, t: Translator): Promise<boolean> {
  if (!close.allowed) return false;
  try {
    const title = close.title ?? await cachedTmdbTitle(input.mediaType, input.correctTmdbId) ?? `TMDB #${input.correctTmdbId}`;
    return await resolveIssueAfterAction({
      issueId: close.issueId,
      about: { tmdbId: input.tmdbId, mediaType: input.mediaType },
      resolution: t("adminQueue.fixMatch.resolutionNote", { title }).slice(0, RESOLUTION_MAX),
      trigger: "fix-match",
      actor: { userId: actor.userId, userName: actor.userName ?? null, ctx: actor.ctx },
    });
  } catch (err) {
    console.error("[fix-match] closing the issue failed:", err instanceof Error ? err.message : err);
    return false;
  }
}
