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
import { ArrResponseError, arrErrorMessage } from "@/lib/arr";
import { deleteArrEntry, loadArrLibraryIndex, resolveArrTargets, type ArrLibraryEntry } from "@/lib/library-cleanup-arr";
import { cleanupKey, type CleanupMediaType } from "@/lib/library-cleanup";
import { CLEANUP_FEATURE_KEY, computeCleanupReport, type CleanupRow, type TitleKey } from "@/lib/library-cleanup-data";
import { translatorForRequest } from "@/lib/i18n/server-locale";

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
// a lost file and never re-pushed to Radarr/Sonarr. The stamp is removed again if
// nothing could be deleted. Status and approvedAt are never touched (guardrail
// 34a; guardrail 14b). Optionally (default on) the title is also blacklisted, so nobody can
// request it again without an admin lifting that.

const MAX_ITEMS = 500;
const TITLE_CONCURRENCY = 2;

type Body = { items?: unknown; blacklist?: unknown; confirmTargets?: unknown };

function parseItems(raw: unknown): TitleKey[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_ITEMS) return null;
  const seen = new Set<string>();
  const out: TitleKey[] = [];
  for (const it of raw) {
    if (!it || typeof it !== "object") return null;
    const { tmdbId, mediaType } = it as { tmdbId?: unknown; mediaType?: unknown };
    if (typeof tmdbId !== "number" || !Number.isInteger(tmdbId) || tmdbId <= 0) return null;
    if (mediaType !== "MOVIE" && mediaType !== "TV") return null;
    const key = cleanupKey(tmdbId, mediaType);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ tmdbId, mediaType });
  }
  return out;
}

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
  const items = parseItems(parsed.items);
  if (!items) {
    return NextResponse.json(
      { error: t("apiAdmin.cleanup.itemsInvalid", { max: MAX_ITEMS }) },
      { status: 400 },
    );
  }
  if (parsed.blacklist !== undefined && typeof parsed.blacklist !== "boolean") {
    return NextResponse.json({ error: t("apiAdmin.cleanup.blacklistBoolean") }, { status: 400 });
  }
  const blacklist = parsed.blacklist !== false;

  // ── plan: re-judge, then resolve every *arr copy ───────────────────────────
  const now = new Date();
  const arr = await loadArrLibraryIndex();
  const report = await computeCleanupReport(arr, now, items);
  const rowByKey = new Map(report.rows.map((r) => [cleanupKey(r.tmdbId, r.mediaType), r]));
  const failedServices = new Map<string, string[]>();
  for (const e of arr.errors) failedServices.set(e.service, [...(failedServices.get(e.service) ?? []), e.instance || "default"]);

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
      const down = failedServices.get(it.mediaType === "MOVIE" ? "radarr" : "sonarr");
      if (down) skipped.push({ ...it, title: row.title, reason: t("apiAdmin.cleanup.arrUnreadable", { service: it.mediaType === "MOVIE" ? "Radarr" : "Sonarr", instances: down.join(", ") }) });
      else eligible.push(row);
    }
  }
  const targetsByKey = await resolveArrTargets(eligible, arr);
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
        hint: `POST {"confirmTargets": ${targetCount}} with the same items to confirm.`,
        targetCount,
        items: plan,
        skipped,
      },
      { status: 409 },
    );
  }

  // ── execute ────────────────────────────────────────────────────────────────
  const scanTypes = new Set<"movie" | "tv">();
  const results = await mapLimit(planned, TITLE_CONCURRENCY, async ({ row, targets }) => {
    const { tmdbId, mediaType, title } = row;
    // Stamp FIRST: if the stamp can't be written the delete must not happen, or
    // the next sync would put the title straight back. Only rows not already
    // stamped are touched, so an unstamp below never clears an older stamp.
    const toStamp = await prisma.mediaRequest.findMany({
      where: { tmdbId, mediaType, status: "AVAILABLE", cleanedUpAt: null },
      select: { id: true },
    });
    const stampedIds = toStamp.map((r) => r.id);
    if (stampedIds.length > 0) {
      await prisma.mediaRequest.updateMany({ where: { id: { in: stampedIds }, cleanedUpAt: null }, data: { cleanedUpAt: now } });
    }

    const deleted: string[] = [];
    const failed: Array<{ target: string; error: string }> = [];
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
        failed.push({ target: targetLabel(t), error: arrErrorMessage(err) });
      }
    }

    if (deleted.length === 0) {
      // Nothing left the title's *arr instances: it is still fully there, so the
      // stamp would only mask a genuine future loss. Remove what this call wrote.
      if (stampedIds.length > 0) {
        await prisma.mediaRequest.updateMany({ where: { id: { in: stampedIds }, cleanedUpAt: now }, data: { cleanedUpAt: null } });
      }
      return { tmdbId, mediaType, title, status: "failed" as const, deleted, failed, blacklisted: false };
    }

    scanTypes.add(mediaType === "MOVIE" ? "movie" : "tv");
    const complete = failed.length === 0;
    let blacklisted = false;
    if (complete) {
      await clearDeletionVotesForTmdbs([{ tmdbId, mediaType }]);
      if (blacklist) {
        // The files are already gone; a failed blacklist write is reported, not thrown.
        try {
          await prisma.blacklistItem.upsert({
            where: { tmdbId_mediaType: { tmdbId, mediaType } },
            create: { tmdbId, mediaType, title, reason: "Removed by library cleanup", addedBy: session.user.id },
            update: {},
          });
          blacklisted = true;
        } catch (err) {
          console.error(`[cleanup] blacklisting ${mediaType}:${tmdbId} after its delete failed:`, err);
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
        requestsStamped: stampedIds.length,
        blacklisted,
      },
      ...auditContext(req, session),
    });
    return { tmdbId, mediaType, title, status: complete ? ("deleted" as const) : ("partial" as const), deleted, failed, blacklisted };
  });

  if (results.some((r) => r.blacklisted)) invalidateBlacklistCache();
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
