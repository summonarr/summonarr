import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { isFeatureEnabled } from "@/lib/features";
import { loadArrLibraryIndex } from "@/lib/library-cleanup-arr";
import { CLEANUP_FEATURE_KEY, computeCleanupReport } from "@/lib/library-cleanup-data";
import { translatorForRequest } from "@/lib/i18n/server-locale";

// Library cleanup report (ADMIN). Judges every library title against the
// configured rules and returns the ones any rule matched — candidates first,
// then the ones an exclusion holds back, with every matched rule and exclusion
// named. Computed on demand: one listing per Radarr/Sonarr instance for sizes and
// delete targets, plus a fixed set of DB aggregates. Nothing is written.
export const GET = withAdmin(async (req) => {
  const t = translatorForRequest(req);
  if (!(await isFeatureEnabled(CLEANUP_FEATURE_KEY))) {
    return NextResponse.json({ error: t("apiAdmin.cleanup.disabled") }, { status: 404 });
  }
  const arr = await loadArrLibraryIndex();
  const report = await computeCleanupReport(arr, new Date());
  const protectedTitles = await prisma.cleanupProtection.findMany({
    orderBy: { createdAt: "desc" },
    take: 1000,
    select: { tmdbId: true, mediaType: true, title: true, reason: true, createdAt: true },
  });
  const candidates = report.rows.filter((r) => r.candidate);
  return NextResponse.json({
    ...report,
    arrErrors: arr.errors,
    protected: protectedTitles.map((p) => ({ ...p, createdAt: p.createdAt.toISOString() })),
    totals: {
      candidates: candidates.length,
      held: report.rows.length - candidates.length,
      reclaimableBytes: candidates.reduce((n, r) => n + (r.sizeOnDisk ?? 0), 0),
    },
  });
});
