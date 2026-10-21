import { NextResponse, after } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { readJsonCapped } from "@/lib/body-size";
import { logAudit, auditContext } from "@/lib/audit";
import { isFeatureEnabled } from "@/lib/features";
import { invalidateBlacklistCache } from "@/lib/blacklist";
import { clearDeletionVotesForTmdbs } from "@/lib/notify-available";
import { scheduleLibraryScan } from "@/lib/library-scan";
import { mapLimit } from "@/lib/concurrency";
import { ArrResponseError, arrErrorKind, arrErrorMessage, arrWriteOutcomeUnknown } from "@/lib/arr";
import type { ArrErrorKind } from "@/lib/arr-error-kind";
import { deleteArrEntry, failedArrInstances, invalidateArrLibraryIndexCache, loadArrLibraryIndex, resolveArrTargets, type ArrLibraryEntry } from "@/lib/library-cleanup-arr";
import { CLEANUP_MAX_ITEMS, cleanupKey, parseCleanupItems, type CleanupMediaType } from "@/lib/library-cleanup";
import { CLEANUP_FEATURE_KEY, cleanupRequestIdentity, computeCleanupReport, type CleanupRow, type TitleKey } from "@/lib/library-cleanup-data";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { invalidateNeverWatchedReport } from "@/lib/never-watched-report";

// Library cleanup delete (ADMIN) — the ONLY way anything in this feature is
// removed, and only ever by an admin's explicit, two-step confirmation:
//
//   POST            → DRY RUN. Re-judges exactly the titles in the body against
//                     the live rules, resolves every Radarr/Sonarr entry each
//                     one occupies (every instance), and returns those targets
//                     plus their count. Nothing is changed.
//   POST ?execute=true with { …same body, confirmTargets: <count> }
//                   → re-resolves the same way and refuses (409) unless the
//                     echoed count matches what it found NOW — the
//                     backfill-playtime confirmation idea: it proves the admin
//                     saw the dry run, and fails closed if anything shifted.
//
// A title that stops being a candidate between the two calls (someone requested
// or started watching it, an admin protected it) drops out of both the targets
// and the count, so the execute 409s rather than deleting it.
//
// Execution is per target through arrFetch with deleteFiles=true and the
// import-list exclusion flag, two titles at a time, one target at a time within
// a title. Partial failure is reported per title, never rolled up into a 500.
//
// Re-download prevention: before deleting, every AVAILABLE request for the title
// is stamped `cleanedUpAt`. The sync's AVAILABLE→APPROVED demote skips a stamped
// row (src/app/api/sync/route.ts), so the title's disappearance is never read as
// a lost file and never re-pushed to Radarr/Sonarr. A title's requests are
// matched by tmdb id OR — for a show — the tvdb id of every Sonarr target
// (cleanupRequestIdentity, the title manager's Remove rule), for both the
// active-request exclusion and the stamp. The stamp is removed again from the
// requests of any instance that definitely refused its delete (that instance
// still holds the title), and from all of them when nothing could be deleted.
// A delete that went through re-asserts the stamp, with its own time, on every
// AVAILABLE request of the title, so a concurrent execute of the same title
// whose delete failed can't unstamp a title that is gone. An UNKNOWN outcome — a timeout, a network failure, a 502/504 from a proxy —
// keeps the stamps — and re-asserts them, as a delete that went through does,
// even when nothing else was deleted: the arr may have taken the delete, and an
// unstamp on a deleted title re-downloads it; the result says `uncertain: true`. Status and
// approvedAt are never touched (guardrail 34a; guardrail 14b). Optionally
// (default on) the title is also blacklisted, so nobody can request it again
// without an admin lifting that.

const TITLE_CONCURRENCY = 2;

type Body = { items?: unknown; blacklist?: unknown; confirmTargets?: unknown };

const targetLabel = (e: Pick<ArrLibraryEntry, "service" | "instance">) => `${e.service}:${e.instance || "default"}`;

type Planned = { row: CleanupRow; targets: ArrLibraryEntry[] };
type Skipped = { tmdbId: number; mediaType: CleanupMediaType; title: string | null; reason: string };

export const POST = withAdmin(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  if (!(await isFeatureEnabled(CLEANUP_FEATURE_KEY))) {
    return NextResponse.json({ error: t("apiAdmin.cleanup.disabled") }, { status: 404 });
  }
  const execute = req.nextUrl.searchParams.get("execute") === "true";
  const parsed = await readJsonCapped<Body>(req, 65_536);
  if (parsed instanceof NextResponse) return parsed;
  // CLEANUP_MAX_ITEMS is the same cap both pages stop their selection at.
  const items: TitleKey[] | null = parseCleanupItems(parsed.items);
  if (!items) {
    return NextResponse.json(
      { error: t("apiAdmin.cleanup.itemsInvalid", { max: CLEANUP_MAX_ITEMS }) },
      { status: 400 },
    );
  }
  if (parsed.blacklist !== undefined && typeof parsed.blacklist !== "boolean") {
    return NextResponse.json({ error: t("apiAdmin.cleanup.blacklistBoolean") }, { status: 400 });
  }
  const blacklist = parsed.blacklist !== false;

  // ── plan: resolve every *arr copy, then re-judge ───────────────────────────
  // The targets come first: a show's Sonarr targets carry the tvdb ids its
  // requests may be linked by (cleanupRequestIdentity), and the judgement must
  // see those requests — an APPROVED one linked only by tvdb id holds it back.
  const now = new Date();
  const arr = await loadArrLibraryIndex();
  // "fetch": the one path allowed to wait on TMDB's tvdb cross-reference — a
  // delete must find every copy it removes (CrossRefMode).
  const targetsByKey = await resolveArrTargets(items, arr, "fetch");
  const tvdbIdsByKey = new Map<string, number[]>();
  for (const [key, entries] of targetsByKey) {
    const ids = entries.flatMap((e) => (e.service === "sonarr" && e.tvdbId !== null ? [e.tvdbId] : []));
    if (ids.length > 0) tvdbIdsByKey.set(key, ids);
  }
  const report = await computeCleanupReport(arr, now, items, { tvdbIds: tvdbIdsByKey, crossRef: "fetch" });
  const rowByKey = new Map(report.rows.map((r) => [cleanupKey(r.tmdbId, r.mediaType), r]));

  const skipped: Skipped[] = [];
  const eligible: CleanupRow[] = [];
  for (const it of items) {
    const row = rowByKey.get(cleanupKey(it.tmdbId, it.mediaType));
    if (!row) {
      skipped.push({ ...it, title: null, reason: t("apiAdmin.cleanup.noRuleMatches") });
    } else if (!row.candidate) {
      skipped.push({
        ...it, title: row.title,
        reason: t("apiAdmin.cleanup.heldBack", { exclusions: row.excludedBy.map((x) => t(`adminManage.cleanup.exclusionLabel.${x}`)).join(", ") }),
      });
    } else {
      // An instance whose listing failed may hold a copy we can't see, and a
      // partial removal would leave the title half-deleted. Refuse rather than guess.
      const down = failedArrInstances(arr, it.mediaType);
      if (down.length > 0) skipped.push({ ...it, title: row.title, reason: t("apiAdmin.cleanup.arrUnreadable", { service: it.mediaType === "MOVIE" ? "Radarr" : "Sonarr", instances: down.join(", ") }) });
      else eligible.push(row);
    }
  }
  const planned: Planned[] = [];
  for (const row of eligible) {
    const targets = targetsByKey.get(cleanupKey(row.tmdbId, row.mediaType)) ?? [];
    if (targets.length === 0) {
      skipped.push({
        tmdbId: row.tmdbId, mediaType: row.mediaType, title: row.title,
        reason: t("apiAdmin.cleanup.notManaged", { service: row.mediaType === "MOVIE" ? "Radarr" : "Sonarr" }),
      });
    } else {
      planned.push({ row, targets });
    }
  }
  const targetCount = planned.reduce((n, p) => n + p.targets.length, 0);
  const plan = planned.map((p) => ({
    tmdbId: p.row.tmdbId,
    mediaType: p.row.mediaType,
    title: p.row.title,
    matched: p.row.matched,
    targets: p.targets.map((t) => ({ service: t.service, instance: t.instance, arrId: t.arrId, title: t.title, sizeOnDisk: t.sizeOnDisk })),
  }));
  const reclaimableBytes = planned.reduce((n, p) => n + p.targets.reduce((m, t) => m + t.sizeOnDisk, 0), 0);

  if (!execute) {
    return NextResponse.json({
      dryRun: true,
      targetCount,
      reclaimableBytes,
      blacklist,
      items: plan,
      skipped,
      hint: `Re-POST with ?execute=true and the same body plus {"confirmTargets": ${targetCount}} to delete.`,
    });
  }

  if (typeof parsed.confirmTargets !== "number" || parsed.confirmTargets !== targetCount || targetCount === 0) {
    return NextResponse.json(
      {
        error: targetCount === 0 ? t("apiAdmin.cleanup.nothingToDelete") : t("apiAdmin.cleanup.confirmationRequired"),
        targetCount,
        items: plan,
        skipped,
      },
      { status: 409 },
    );
  }

  // ── execute ────────────────────────────────────────────────────────────────
  const scanTypes = new Set<"movie" | "tv">();
  // Resolved once, outside the per-title task (whose `for (const t of targets)`
  // shadows the translator): the stored reason follows the instance language
  // like every admin-typed reason beside it in the Blacklist list.
  const blacklistReason = t("apiAdmin.cleanup.blacklistReason");
  const results = await mapLimit(planned, TITLE_CONCURRENCY, async ({ row, targets }) => {
    const { tmdbId, mediaType, title } = row;
    // Stamp FIRST: if the stamp can't be written the delete must not happen, or
    // the next sync would put the title straight back. Only rows not already
    // stamped are touched, so an unstamp below never clears an older stamp.
    const toStamp = await prisma.mediaRequest.findMany({
      where: {
        ...cleanupRequestIdentity(tmdbId, mediaType, targets.map((e) => e.tvdbId)),
        mediaType, status: "AVAILABLE", cleanedUpAt: null,
      },
      select: { id: true, arrInstance: true },
    });
    const stampedIds = toStamp.map((r) => r.id);
    if (stampedIds.length > 0) {
      await prisma.mediaRequest.updateMany({ where: { id: { in: stampedIds }, cleanedUpAt: null }, data: { cleanedUpAt: now } });
    }

    const deleted: string[] = [];
    // `error` is the English detail (older pages print it); the page translates
    // `kind` through ARR_ERROR_KIND_KEYS, naming the instance from service +
    // instance (guardrail 5e).
    const failed: Array<{ target: string; service: ArrLibraryEntry["service"]; instance: string; error: string; kind: ArrErrorKind }> = [];
    // Instances that definitely refused the delete — they still hold the title.
    const stillHeldOn = new Set<string>();
    // A delete whose outcome is unknown: the arr may have removed the title
    // anyway, so its stamps stay (guardrail 14b).
    let uncertain = false;
    for (const t of targets) {
      try {
        await deleteArrEntry(t);
        deleted.push(targetLabel(t));
      } catch (err) {
        // Gone already (removed by hand since the listing): the goal is met.
        if (err instanceof ArrResponseError && err.status === 404) {
          deleted.push(targetLabel(t));
          continue;
        }
        console.error(`[cleanup] delete of ${mediaType}:${tmdbId} from ${targetLabel(t)} failed:`, err instanceof Error ? err.message : err);
        failed.push({ target: targetLabel(t), service: t.service, instance: t.instance, error: arrErrorMessage(err), kind: arrErrorKind(err) });
        if (arrWriteOutcomeUnknown(err)) uncertain = true;
        else stillHeldOn.add(t.instance);
      }
    }

    // This call now OWNS the stamp on every AVAILABLE request of the title
    // (except on an instance that still holds it). A concurrent execute of the
    // same title stamped first and found nothing for this call to own; if ITS
    // delete then fails, its unstamp (keyed on its own `now`) would clear the
    // only stamp on a title that is gone, and the next sync would re-download
    // it (14b). Re-asserted with this call's time, the other unstamp misses the
    // rows — and if it already ran, this writes them back. Only null vs set is
    // ever read, so moving an older stamp's time is harmless. Written by id,
    // whatever the row's stamp says now: that is what overrides (or writes
    // back) the other call's. Run after a delete that went through AND after
    // one whose outcome is unknown — "maybe deleted" holds the stamp exactly as
    // "deleted" does. Best-effort: the error is returned, never thrown.
    const reassertStamps = async (): Promise<string | undefined> => {
      try {
        const own = (await prisma.mediaRequest.findMany({
          where: { ...cleanupRequestIdentity(tmdbId, mediaType, targets.map((e) => e.tvdbId)), mediaType, status: "AVAILABLE" },
          select: { id: true, arrInstance: true },
        })).filter((r) => !stillHeldOn.has(r.arrInstance)).map((r) => r.id);
        if (own.length > 0) {
          await prisma.mediaRequest.updateMany({ where: { id: { in: own }, status: "AVAILABLE" }, data: { cleanedUpAt: now } });
        }
        return undefined;
      } catch (err) {
        console.error(`[cleanup] re-asserting ${mediaType}:${tmdbId}'s cleanup stamp after its delete failed:`, err);
        return err instanceof Error ? err.message : String(err);
      }
    };

    if (deleted.length === 0) {
      // Every instance refused: the title is still fully there, so the stamp
      // would only mask a genuine future loss. Remove what this call wrote.
      // When an outcome is unknown that delete may have gone through: only the
      // requests on instances that definitely refused lose theirs, and the
      // rest are re-asserted — this call may own nothing (a concurrent execute
      // stamped first) and that execute's definite refusal must not leave a
      // maybe-deleted title unstamped.
      const unstamp = uncertain ? toStamp.filter((r) => stillHeldOn.has(r.arrInstance)).map((r) => r.id) : stampedIds;
      if (unstamp.length > 0) {
        await prisma.mediaRequest.updateMany({ where: { id: { in: unstamp }, cleanedUpAt: now }, data: { cleanedUpAt: null } });
      }
      const reassertError = uncertain ? await reassertStamps() : undefined;
      return {
        tmdbId, mediaType, title, status: "failed" as const, deleted, failed, blacklisted: false,
        ...(uncertain ? { uncertain: true } : {}),
        ...(reassertError ? { bookkeepingError: reassertError } : {}),
      };
    }

    scanTypes.add(mediaType === "MOVIE" ? "movie" : "tv");
    const complete = failed.length === 0;
    let blacklisted = false;
    // Everything past this point is bookkeeping for a delete that is already
    // durable upstream. mapLimit rejects the WHOLE batch on one rejected task,
    // which would 500 the response after Radarr/Sonarr removed the files and
    // leave the admin not knowing which titles went — so a failed unstamp, vote
    // clear or blacklist write is recorded on this title's result, never thrown.
    let bookkeepingError: string | undefined;
    // A partial result: the same reasoning as above, per instance. An instance
    // that refused its delete still holds the title, so its requests' stamps
    // would only mask a genuine future loss there (one whose outcome is unknown
    // is not in stillHeldOn: its stamps stay). Requests on every other instance
    // keep theirs. A request is routed to the instance of the title's own
    // service (Radarr for a movie, Sonarr for a show), so the slug alone names it.
    const unstampIds = toStamp.filter((r) => stillHeldOn.has(r.arrInstance)).map((r) => r.id);
    let requestsStamped = stampedIds.length;
    if (unstampIds.length > 0) {
      try {
        await prisma.mediaRequest.updateMany({ where: { id: { in: unstampIds }, cleanedUpAt: now }, data: { cleanedUpAt: null } });
        requestsStamped -= unstampIds.length;
      } catch (err) {
        console.error(`[cleanup] un-stamping ${mediaType}:${tmdbId}'s requests on the instances whose delete failed failed:`, err);
        bookkeepingError = err instanceof Error ? err.message : String(err);
      }
    }
    const reassertError = await reassertStamps();
    bookkeepingError ??= reassertError;
    if (complete) {
      try {
        await clearDeletionVotesForTmdbs([{ tmdbId, mediaType }]);
      } catch (err) {
        console.error(`[cleanup] clearing deletion votes for ${mediaType}:${tmdbId} after its delete failed:`, err);
        bookkeepingError = err instanceof Error ? err.message : String(err);
      }
      if (blacklist) {
        // The files are already gone; a failed blacklist write is reported, not thrown.
        try {
          await prisma.blacklistItem.upsert({
            where: { tmdbId_mediaType: { tmdbId, mediaType } },
            create: { tmdbId, mediaType, title, reason: blacklistReason, addedBy: session.user.id },
            update: {},
          });
          blacklisted = true;
        } catch (err) {
          console.error(`[cleanup] blacklisting ${mediaType}:${tmdbId} after its delete failed:`, err);
          bookkeepingError ??= err instanceof Error ? err.message : String(err);
        }
      }
    }
    // The upstream delete is durable; a failed audit write must not turn it into
    // an error (guardrail 26).
    void logAudit({
      userId: session.user.id,
      userName: session.user.name ?? session.user.email,
      action: "LIBRARY_CLEANUP_DELETE",
      target: `cleanup:${mediaType}:${tmdbId}`,
      details: {
        title,
        matched: row.matched,
        deleted,
        failed: failed.map((f) => f.target),
        sizeOnDisk: targets.reduce((n, t) => n + t.sizeOnDisk, 0),
        requestsStamped,
        blacklisted,
        ...(uncertain ? { uncertain: true } : {}),
      },
      ...auditContext(req, session),
    });
    return {
      tmdbId, mediaType, title,
      status: complete ? ("deleted" as const) : ("partial" as const),
      deleted, failed, blacklisted,
      ...(uncertain ? { uncertain: true } : {}),
      ...(bookkeepingError ? { bookkeepingError } : {}),
    };
  });

  if (results.some((r) => r.blacklisted)) invalidateBlacklistCache();
  // Read-only views cache the Radarr/Sonarr listing and the never-watched
  // report; what was just deleted must not keep showing there.
  // A delete whose outcome is unknown may have removed the title as well.
  if (results.some((r) => r.deleted.length > 0 || ("uncertain" in r && r.uncertain === true))) {
    invalidateArrLibraryIndexCache();
    invalidateNeverWatchedReport();
  }
  // Let Plex/Jellyfin notice the files are gone; the next library sync then
  // drops their rows (this route never touches library rows itself).
  for (const type of scanTypes) after(() => scheduleLibraryScan(type));

  return NextResponse.json({
    dryRun: false,
    deletedCount: results.filter((r) => r.status === "deleted").length,
    partialCount: results.filter((r) => r.status === "partial").length,
    failedCount: results.filter((r) => r.status === "failed").length,
    results,
    skipped,
  });
});
