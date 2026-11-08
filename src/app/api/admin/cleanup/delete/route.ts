import { NextResponse, after } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { readJsonCapped } from "@/lib/body-size";
import { auditActor } from "@/lib/audit";
import { invalidateBlacklistCache } from "@/lib/blacklist";
import { scheduleLibraryScan } from "@/lib/library-scan";
import { mapLimit } from "@/lib/concurrency";
import { cleanupTargetsFingerprint, failedArrInstances, invalidateArrLibraryIndexCache, loadArrLibraryIndex, resolveArrTargetsChecked, type ArrLibraryEntry } from "@/lib/library-cleanup-arr";
import { CLEANUP_MAX_ITEMS, cleanupKey, parseCleanupItems, type CleanupMediaType } from "@/lib/library-cleanup";
import { computeCleanupReport, type CleanupRow, type TitleKey } from "@/lib/library-cleanup-data";
import { executeCleanupTitle } from "@/lib/library-cleanup-execute";
import { cleanupDisabledResponse } from "@/lib/library-cleanup-gate";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { invalidateNeverWatchedReport } from "@/lib/never-watched-report";
import { arrServiceName } from "@/lib/arr-service-name";

// Library cleanup delete (ADMIN) — the ONLY way anything in this feature is
// removed, and only ever by an admin's explicit, two-step confirmation:
//
//   POST            → DRY RUN. Re-judges exactly the titles in the body against
//                     the live rules, resolves every Radarr/Sonarr entry each
//                     one occupies (every instance), and returns those targets
//                     plus their count. Nothing is changed.
//   POST ?execute=true with { …same body, confirmTargets: <count>,
//                             confirmFingerprint: <targetsFingerprint> }
//                   → re-resolves the same way and refuses (409) unless the
//                     echoed count — and, when sent, the fingerprint of the
//                     exact target set — matches what it found NOW: the
//                     backfill-playtime confirmation idea. It proves the admin
//                     saw the dry run, and fails closed if anything shifted.
//                     The count alone can't see a same-sized different set
//                     (one copy gone, another appeared on a second instance);
//                     the fingerprint can. It stays optional so an API caller
//                     that echoes only the count keeps working; the page
//                     always sends it.
//
// A title that stops being a candidate between the two calls (someone requested
// or started watching it, an admin protected it) drops out of both the targets
// and the count, so the execute 409s rather than deleting it.
//
// Execution is per target through arrFetch with deleteFiles=true and the
// import-list exclusion flag, two titles at a time, one target at a time within
// a title (executeCleanupTitle, library-cleanup-execute.ts — the cleanedUpAt
// stamps that stop a re-download live there, guardrail 14b). Partial failure is
// reported per title, never rolled up into a 500. Optionally (default on) the
// title is also blacklisted, so nobody can request it again without an admin
// lifting that.

const TITLE_CONCURRENCY = 2;

type Body = { items?: unknown; blacklist?: unknown; confirmTargets?: unknown; confirmFingerprint?: unknown };

type Planned = { row: CleanupRow; targets: ArrLibraryEntry[] };
type Skipped = { tmdbId: number; mediaType: CleanupMediaType; title: string | null; reason: string };

type Translate = ReturnType<typeof translatorForRequest>;

// ── plan: resolve every *arr copy, then re-judge ───────────────────────────
// The targets come first: a show's Sonarr targets carry the tvdb ids its
// requests may be linked by (cleanupRequestIdentity), and the judgement must
// see those requests — an APPROVED one linked only by tvdb id holds it back.
// Every title asked about is either planned (a candidate now, with every copy
// to delete) or skipped with the reason.
async function planDeletes(items: TitleKey[], now: Date, t: Translate): Promise<{ planned: Planned[]; skipped: Skipped[] }> {
  const arr = await loadArrLibraryIndex();
  // "fetch": the one path allowed to wait on TMDB's tvdb cross-reference — a
  // delete must find every copy it removes (CrossRefMode).
  const { targets: targetsByKey, unresolved } = await resolveArrTargetsChecked(items, arr, "fetch");
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
      // Likewise a show whose TVDB cross-reference lookup failed: a tvdb-only
      // Sonarr copy of it can't be looked for, so the delete could miss it.
      const unchecked = unresolved.get(cleanupKey(it.tmdbId, it.mediaType));
      if (down.length > 0) skipped.push({ ...it, title: row.title, reason: t("apiAdmin.cleanup.arrUnreadable", { service: arrServiceName(it.mediaType), instances: down.join(", ") }) });
      else if (unchecked) skipped.push({ ...it, title: row.title, reason: t("apiAdmin.cleanup.crossRefUnavailable", { service: arrServiceName(it.mediaType), instances: unchecked.join(", ") }) });
      else eligible.push(row);
    }
  }
  const planned: Planned[] = [];
  for (const row of eligible) {
    const targets = targetsByKey.get(cleanupKey(row.tmdbId, row.mediaType)) ?? [];
    if (targets.length === 0) {
      skipped.push({ tmdbId: row.tmdbId, mediaType: row.mediaType, title: row.title, reason: t("apiAdmin.cleanup.notManaged", { service: arrServiceName(row.mediaType) }) });
    } else {
      planned.push({ row, targets });
    }
  }
  return { planned, skipped };
}

// What the dry run shows and the execute must be confirmed against.
function planSummary(planned: Planned[]) {
  return {
    targetCount: planned.reduce((n, p) => n + p.targets.length, 0),
    plan: planned.map((p) => ({
      tmdbId: p.row.tmdbId,
      mediaType: p.row.mediaType,
      title: p.row.title,
      matched: p.row.matched,
      targets: p.targets.map((e) => ({ service: e.service, instance: e.instance, arrId: e.arrId, title: e.title, sizeOnDisk: e.sizeOnDisk })),
    })),
    reclaimableBytes: planned.reduce((n, p) => n + p.targets.reduce((m, e) => m + e.sizeOnDisk, 0), 0),
    targetsFingerprint: cleanupTargetsFingerprint(planned.map((p) => ({ tmdbId: p.row.tmdbId, mediaType: p.row.mediaType, targets: p.targets }))),
  };
}

export const POST = withAdmin(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  const off = await cleanupDisabledResponse(t);
  if (off) return off;
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

  const now = new Date();
  const { planned, skipped } = await planDeletes(items, now, t);
  const { targetCount, plan, reclaimableBytes, targetsFingerprint } = planSummary(planned);

  if (!execute) {
    return NextResponse.json({
      dryRun: true,
      targetCount,
      targetsFingerprint,
      reclaimableBytes,
      blacklist,
      items: plan,
      skipped,
      hint: `Re-POST with ?execute=true and the same body plus {"confirmTargets": ${targetCount}, "confirmFingerprint": "${targetsFingerprint}"} to delete.`,
    });
  }

  // Sent (the page always sends it): it must name exactly the set found now.
  const setChanged = parsed.confirmFingerprint !== undefined && parsed.confirmFingerprint !== targetsFingerprint;
  if (typeof parsed.confirmTargets !== "number" || parsed.confirmTargets !== targetCount || targetCount === 0 || setChanged) {
    return NextResponse.json(
      {
        error: targetCount === 0 ? t("apiAdmin.cleanup.nothingToDelete") : t("apiAdmin.cleanup.confirmationRequired"),
        targetCount,
        targetsFingerprint,
        // The fresh plan's size, as the dry run answers it: the page confirms against it.
        reclaimableBytes,
        items: plan,
        skipped,
      },
      { status: 409 },
    );
  }

  // ── execute ────────────────────────────────────────────────────────────────
  const ctx = {
    now,
    blacklist,
    // The stored reason follows the instance language like every admin-typed
    // reason beside it in the Blacklist list.
    blacklistReason: t("apiAdmin.cleanup.blacklistReason"),
    actor: auditActor(req, session),
  };
  const results = await mapLimit(planned, TITLE_CONCURRENCY, (p) => executeCleanupTitle(p, ctx));

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
  const scanTypes = new Set(results.filter((r) => r.deleted.length > 0).map((r) => (r.mediaType === "MOVIE" ? "movie" as const : "tv" as const)));
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
