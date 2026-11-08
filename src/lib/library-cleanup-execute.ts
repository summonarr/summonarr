// The execute step of a Library cleanup delete (POST /api/admin/cleanup/delete
// ?execute=true), one planned title at a time: stamp, delete, reconcile the
// stamps, then the bookkeeping. The route plans, confirms and reports; the
// rules for the stamps (guardrail 14b) live here.
//
// Re-download prevention: before deleting, every AVAILABLE request for the
// title is stamped `cleanedUpAt`. The sync's AVAILABLE→APPROVED demote skips a
// stamped row, so the title's disappearance is never read as a lost file and
// never re-pushed to Radarr/Sonarr. A title's requests are matched by tmdb id
// OR — for a show — the tvdb id of every Sonarr target (cleanupRequestIdentity,
// the title manager's Remove rule). The stamp comes off again from the
// requests of any instance that definitely refused its delete (it still holds
// the title), and from all of them when nothing could be deleted. A delete that
// went through re-asserts the stamp, with its own time, on every AVAILABLE
// request of the title, so a concurrent execute of the same title whose delete
// failed can't unstamp a title that is gone. An UNKNOWN outcome — a timeout, a
// network failure, a 502/504 from a proxy — keeps the stamps and re-asserts
// them, as a delete that went through does: the arr may have taken the delete,
// and an unstamp on a deleted title re-downloads it. Status and approvedAt are
// never touched (guardrails 34a, 14b).
import { prisma } from "./prisma";
import { logAudit, type AuditParams } from "./audit";
import { ArrResponseError, arrErrorKind, arrErrorMessage, arrWriteOutcomeUnknown } from "./arr";
import type { ArrErrorKind } from "./arr-error-kind";
import { dropArrTitleSnapshots } from "./arr-snapshot";
import { deleteArrEntry, type ArrLibraryEntry } from "./library-cleanup-arr";
import type { CleanupMediaType } from "./library-cleanup";
import { cleanupRequestIdentity, type CleanupRow } from "./library-cleanup-data";
import { clearDeletionVotesForTmdbs } from "./notify-available";

export const targetLabel = (e: Pick<ArrLibraryEntry, "service" | "instance">) => `${e.service}:${e.instance || "default"}`;

// `error` is the English detail (older pages print it); the page translates
// `kind` through ARR_ERROR_KIND_KEYS, naming the instance from service +
// instance (guardrail 5e).
export type CleanupTargetFailure = {
  target: string;
  service: ArrLibraryEntry["service"];
  instance: string;
  error: string;
  kind: ArrErrorKind;
};

export type CleanupTitleResult = {
  tmdbId: number;
  mediaType: CleanupMediaType;
  title: string;
  status: "deleted" | "partial" | "failed";
  deleted: string[];
  failed: CleanupTargetFailure[];
  blacklisted: boolean;
  uncertain?: true;
  // Every bookkeeping write that failed, joined in the order they ran — never
  // the first or the last alone, so one failure can't mask another (an unstamp
  // or re-assert failure is the one guardrail 14b cares about).
  bookkeepingError?: string;
};

export type CleanupExecuteContext = {
  now: Date;
  blacklist: boolean;
  // Already translated: the stored reason follows the instance language.
  blacklistReason: string;
  // Who is deleting, for the audit row and the blacklist entry.
  actor: Omit<AuditParams, "action" | "target" | "details"> & { userId: string };
};

type StampedRequest = { id: string; arrInstance: string };

/** How the title's deletes went, target by target. */
export type DeleteOutcome = {
  deleted: string[];
  failed: CleanupTargetFailure[];
  // Instances that definitely refused the delete — they still hold the title.
  stillHeldOn: Set<string>;
  // A delete whose outcome is unknown: the arr may have removed the title
  // anyway, so its stamps stay (guardrail 14b).
  uncertain: boolean;
};

/**
 * The requests this call stamped that must lose the stamp again — the ONE
 * place that is decided. Nothing deleted and nothing uncertain: every one (the
 * title is still fully there, and the stamp would only mask a genuine future
 * loss). Otherwise only those on an instance that definitely refused (it still
 * holds the title): a request on any other instance keeps its stamp, and so
 * does one whose delete has an unknown outcome. A request is routed to the
 * instance of the title's own service, so the slug alone names it.
 */
export function requestsToUnstamp(stamped: readonly StampedRequest[], outcome: Pick<DeleteOutcome, "deleted" | "stillHeldOn" | "uncertain">): string[] {
  if (outcome.deleted.length === 0 && !outcome.uncertain) return stamped.map((r) => r.id);
  return stamped.filter((r) => outcome.stillHeldOn.has(r.arrInstance)).map((r) => r.id);
}

// Stamp FIRST: if the stamp can't be written the delete must not happen, or the
// next sync would put the title straight back. Only rows not already stamped
// are touched, so an unstamp later never clears an older stamp. Throws.
async function stampRequests(row: CleanupRow, targets: readonly ArrLibraryEntry[], now: Date): Promise<StampedRequest[]> {
  const toStamp = await prisma.mediaRequest.findMany({
    where: {
      ...cleanupRequestIdentity(row.tmdbId, row.mediaType, targets.map((e) => e.tvdbId)),
      mediaType: row.mediaType, status: "AVAILABLE", cleanedUpAt: null,
    },
    select: { id: true, arrInstance: true },
  });
  if (toStamp.length > 0) {
    await prisma.mediaRequest.updateMany({ where: { id: { in: toStamp.map((r) => r.id) }, cleanedUpAt: null }, data: { cleanedUpAt: now } });
  }
  return toStamp;
}

// The title manager's kept views of a title that is gone would 404 on every
// background re-read (guardrail 5h) — drop them, as Remove does. A display
// cache: a failure here is logged and never touches the delete's outcome.
function dropSnapshots(t: ArrLibraryEntry, tmdbId: number): void {
  try {
    dropArrTitleSnapshots({ service: t.service, instance: t.instance, arrId: t.arrId, tmdbId });
  } catch (err) {
    console.warn(`[cleanup] dropping the title manager's snapshots of ${targetLabel(t)} #${t.arrId} failed:`, err instanceof Error ? err.message : err);
  }
}

// Each target's delete (deleteFiles=true and the import-list exclusion), one
// at a time. A target already gone (404) counts as deleted: the goal is met.
async function deleteTargets(row: CleanupRow, targets: readonly ArrLibraryEntry[]): Promise<DeleteOutcome> {
  const outcome: DeleteOutcome = { deleted: [], failed: [], stillHeldOn: new Set(), uncertain: false };
  for (const t of targets) {
    try {
      await deleteArrEntry(t);
    } catch (err) {
      if (!(err instanceof ArrResponseError && err.status === 404)) {
        console.error(`[cleanup] delete of ${row.mediaType}:${row.tmdbId} from ${targetLabel(t)} failed:`, err instanceof Error ? err.message : err);
        outcome.failed.push({ target: targetLabel(t), service: t.service, instance: t.instance, error: arrErrorMessage(err), kind: arrErrorKind(err) });
        if (arrWriteOutcomeUnknown(err)) outcome.uncertain = true;
        else outcome.stillHeldOn.add(t.instance);
        continue;
      }
    }
    outcome.deleted.push(targetLabel(t));
    dropSnapshots(t, row.tmdbId);
  }
  return outcome;
}

// This call now OWNS the stamp on every AVAILABLE request of the title (except
// on an instance that still holds it). A concurrent execute of the same title
// stamped first and found nothing for this call to own; if ITS delete then
// fails, its unstamp (keyed on its own `now`) would clear the only stamp on a
// title that is gone, and the next sync would re-download it (14b).
// Re-asserted with this call's time, the other unstamp misses the rows — and
// if it already ran, this writes them back. Only null vs set is ever read, so
// moving an older stamp's time is harmless — and that is also why the write
// may NOT be narrowed to rows this call stamped: whatever the row's stamp says
// now is what it overrides (or writes back). Run after a delete that went
// through AND after one whose outcome is unknown — "maybe deleted" holds the
// stamp exactly as "deleted" does. Throws; the caller records it.
async function reassertStamps(row: CleanupRow, targets: readonly ArrLibraryEntry[], stillHeldOn: ReadonlySet<string>, now: Date): Promise<void> {
  const own = (await prisma.mediaRequest.findMany({
    where: { ...cleanupRequestIdentity(row.tmdbId, row.mediaType, targets.map((e) => e.tvdbId)), mediaType: row.mediaType, status: "AVAILABLE" },
    select: { id: true, arrInstance: true },
  })).filter((r) => !stillHeldOn.has(r.arrInstance)).map((r) => r.id);
  if (own.length > 0) {
    await prisma.mediaRequest.updateMany({ where: { id: { in: own }, status: "AVAILABLE" }, data: { cleanedUpAt: now } });
  }
}

type Note = (err: unknown) => void;

// Puts the stamps right after the deletes (requestsToUnstamp, then the
// re-assert); answers how many of this call's stamps remain. Failures are
// noted, never thrown.
async function reconcileStamps(
  row: CleanupRow,
  targets: readonly ArrLibraryEntry[],
  stamped: readonly StampedRequest[],
  outcome: DeleteOutcome,
  now: Date,
  note: Note,
): Promise<number> {
  const { mediaType, tmdbId } = row;
  const anyDeleted = outcome.deleted.length > 0;
  let requestsStamped = stamped.length;
  const unstamp = requestsToUnstamp(stamped, outcome);
  if (unstamp.length > 0) {
    try {
      await prisma.mediaRequest.updateMany({ where: { id: { in: unstamp }, cleanedUpAt: now }, data: { cleanedUpAt: null } });
      requestsStamped -= unstamp.length;
    } catch (err) {
      console.error(
        anyDeleted
          ? `[cleanup] un-stamping ${mediaType}:${tmdbId}'s requests on the instances whose delete failed failed:`
          : `[cleanup] un-stamping ${mediaType}:${tmdbId}'s requests after every delete was refused failed:`,
        err,
      );
      note(err);
    }
  }
  if (anyDeleted || outcome.uncertain) {
    try {
      await reassertStamps(row, targets, outcome.stillHeldOn, now);
    } catch (err) {
      console.error(`[cleanup] re-asserting ${mediaType}:${tmdbId}'s cleanup stamp after its delete failed:`, err);
      note(err);
    }
  }
  return requestsStamped;
}

// A title gone from every instance: its deletion votes are spent and (unless
// the admin unticked it) it is blacklisted. The files are already gone, so a
// failed write is noted, not thrown. Answers whether it was blacklisted.
async function retireTitle(row: CleanupRow, ctx: CleanupExecuteContext, note: Note): Promise<boolean> {
  const { tmdbId, mediaType, title } = row;
  try {
    await clearDeletionVotesForTmdbs([{ tmdbId, mediaType }]);
  } catch (err) {
    console.error(`[cleanup] clearing deletion votes for ${mediaType}:${tmdbId} after its delete failed:`, err);
    note(err);
  }
  if (!ctx.blacklist) return false;
  try {
    await prisma.blacklistItem.upsert({
      where: { tmdbId_mediaType: { tmdbId, mediaType } },
      create: { tmdbId, mediaType, title, reason: ctx.blacklistReason, addedBy: ctx.actor.userId },
      update: {},
    });
    return true;
  } catch (err) {
    console.error(`[cleanup] blacklisting ${mediaType}:${tmdbId} after its delete failed:`, err);
    note(err);
    return false;
  }
}

/**
 * Runs one planned title. Never throws: everything past the upstream delete is
 * bookkeeping for a delete that is already durable, and a throw would reject
 * the whole batch (a 500 after Radarr/Sonarr removed the files, the admin not
 * knowing which titles went) — so a failed write is recorded on the result.
 */
export async function executeCleanupTitle(
  { row, targets }: { row: CleanupRow; targets: ArrLibraryEntry[] },
  ctx: CleanupExecuteContext,
): Promise<CleanupTitleResult> {
  const { tmdbId, mediaType, title } = row;
  let stamped: StampedRequest[];
  try {
    stamped = await stampRequests(row, targets, ctx.now);
  } catch (err) {
    // This title's failure, not the batch's. Nothing was deleted for it.
    console.error(`[cleanup] stamping ${mediaType}:${tmdbId}'s requests failed — not deleting it:`, err);
    return {
      tmdbId, mediaType, title, status: "failed", deleted: [], failed: [], blacklisted: false,
      bookkeepingError: err instanceof Error ? err.message : String(err),
    };
  }

  const bookkeeping: string[] = [];
  const note: Note = (err) => { bookkeeping.push(err instanceof Error ? err.message : String(err)); };

  const outcome = await deleteTargets(row, targets);
  const { deleted, failed, uncertain } = outcome;
  const requestsStamped = await reconcileStamps(row, targets, stamped, outcome, ctx.now, note);
  const status: CleanupTitleResult["status"] = deleted.length === 0 ? "failed" : failed.length === 0 ? "deleted" : "partial";
  const blacklisted = status === "deleted" ? await retireTitle(row, ctx, note) : false;

  // Audited when anything may have been deleted: a delete that went through,
  // and one whose outcome is unknown (the arr may have removed the files — the
  // stamps already treat it so). A title every instance definitely refused
  // changed nothing and is not. After the upstream delete, swallowing
  // (guardrail 26).
  if (deleted.length > 0 || uncertain) {
    void logAudit({
      ...ctx.actor,
      action: "LIBRARY_CLEANUP_DELETE",
      target: `cleanup:${mediaType}:${tmdbId}`,
      details: {
        title,
        matched: row.matched,
        status,
        deleted,
        failed: failed.map((f) => f.target),
        sizeOnDisk: targets.reduce((n, t) => n + t.sizeOnDisk, 0),
        requestsStamped,
        blacklisted,
        ...(uncertain ? { uncertain: true } : {}),
      },
    });
  }
  const bookkeepingError = bookkeeping.length > 0 ? bookkeeping.join("; ") : undefined;
  return {
    tmdbId, mediaType, title, status, deleted, failed, blacklisted,
    ...(uncertain ? { uncertain: true as const } : {}),
    ...(bookkeepingError ? { bookkeepingError } : {}),
  };
}
