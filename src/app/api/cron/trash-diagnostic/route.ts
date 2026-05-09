import { NextRequest, NextResponse } from "next/server";
import { isCronAuthorized } from "@/lib/cron-auth";
import { prisma } from "@/lib/prisma";
import { describeSchemaError } from "@/lib/trash";
import { resolveStarterPack, STARTER_PACK } from "@/lib/trash-recommendations";

async function handle(request: NextRequest) {
  if (!(await isCronAuthorized(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const report: Record<string, unknown> = { timestamp: new Date().toISOString() };

  try {
    const tables = await prisma.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename IN ('TrashSpec', 'TrashApplication')
      ORDER BY tablename
    `;
    report.tables = {
      TrashSpec: tables.some((t) => t.tablename === "TrashSpec"),
      TrashApplication: tables.some((t) => t.tablename === "TrashApplication"),
    };
  } catch (err) {
    report.tables = { error: err instanceof Error ? err.message : String(err) };
  }

  try {
    const [specCountsRaw, appCount] = await Promise.all([
      prisma.trashSpec.groupBy({ by: ["service", "kind"], _count: { _all: true } }),
      prisma.trashApplication.count(),
    ]);
    report.counts = {
      specsByService: specCountsRaw.map((c) => ({ service: c.service, kind: c.kind, count: c._count._all })),
      totalSpecs: specCountsRaw.reduce((n, c) => n + c._count._all, 0),
      totalApplications: appCount,
    };
  } catch (err) {
    const hint = describeSchemaError(err);
    report.counts = { error: err instanceof Error ? err.message : String(err), schemaDiagnostic: hint };
  }

  try {
    const sample = await prisma.trashSpec.findMany({
      take: 6,
      orderBy: [{ kind: "asc" }, { name: "asc" }],
      select: { id: true, service: true, kind: true, trashId: true, name: true, upstreamSha: true, fetchedAt: true },
    });
    report.sampleSpecs = sample;
  } catch (err) {
    report.sampleSpecs = { error: err instanceof Error ? err.message : String(err) };
  }

  try {
    const starter = await resolveStarterPack();
    report.starterPack = {
      expected: STARTER_PACK.length,
      resolved: starter.filter((s) => s.spec).length,
      missing: starter.filter((s) => !s.spec).map((s) => ({
        label: s.item.label,
        service: s.item.service,
        kind: s.item.kind,
        match: s.item.match,
      })),
      resolvedDetails: starter.filter((s) => s.spec).map((s) => ({
        label: s.item.label,
        matched: s.spec,
        applied: s.application?.appliedAt != null,
        enabled: s.application?.enabled ?? null,
        lastError: s.application?.lastError ?? null,
      })),
    };
  } catch (err) {
    const hint = describeSchemaError(err);
    report.starterPack = { error: err instanceof Error ? err.message : String(err), schemaDiagnostic: hint };
  }

  try {
    const audits = await prisma.auditLog.findMany({
      where: { target: { in: ["trash:refresh", "trash-sync", "trash:starter-pack", "trash:apply"] } },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { target: true, createdAt: true, details: true, userName: true },
    });
    report.recentAudit = audits.map((a) => {
      let parsed: unknown = a.details;
      if (a.details) {
        try { parsed = JSON.parse(a.details); } catch { }
      }
      return { target: a.target, at: a.createdAt.toISOString(), userName: a.userName, details: parsed };
    });
  } catch (err) {
    report.recentAudit = { error: err instanceof Error ? err.message : String(err) };
  }

  try {
    const keys = [
      "trashGuidesEnabled",
      "trashSyncCustomFormats",
      "trashSyncQualityProfiles",
      "trashSyncNaming",
      "trashGithubToken",
      "radarrUrl",
      "radarrApiKey",
      "sonarrUrl",
      "sonarrApiKey",
    ];
    const rows = await prisma.setting.findMany({ where: { key: { in: keys } }, select: { key: true, value: true } });
    const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    const sensitive = new Set(["trashGithubToken", "radarrApiKey", "sonarrApiKey"]);
    report.config = Object.fromEntries(
      keys.map((k) => [k, sensitive.has(k) ? (map[k] ? "configured" : "unset") : (map[k] ?? null)]),
    );

    report.encryption = {
      keySet: Boolean(process.env.TOKEN_ENCRYPTION_KEY && process.env.TOKEN_ENCRYPTION_KEY.length === 64),
    };
  } catch (err) {
    report.config = { error: err instanceof Error ? err.message : String(err) };
  }

  // Surface the persisted GitHub-tree truncation marker (set in trash.ts ghTree). Absence = never truncated.
  try {
    const truncRow = await prisma.setting.findUnique({
      where: { key: "trashLastRefreshTruncatedAt" },
      select: { value: true },
    });
    report.lastRefreshTruncatedAt = truncRow?.value ?? null;
  } catch (err) {
    report.lastRefreshTruncatedAt = null;
    void err;
  }

  // Per-spec error stats — failingByKind = total apps with lastError set per kind;
  // flapping = apps with errorCount >= 3 and lastErrorAt within the last 24h.
  try {
    const failingApps = await prisma.trashApplication.findMany({
      where: { lastError: { not: null } },
      select: {
        trashSpec: { select: { kind: true, name: true, service: true } },
        errorCount: true,
        lastErrorAt: true,
        lastError: true,
      },
    });
    const failingByKind: Record<string, number> = {};
    for (const a of failingApps) {
      const k = a.trashSpec.kind;
      failingByKind[k] = (failingByKind[k] ?? 0) + 1;
    }
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const flapping = failingApps
      .filter((a) => a.errorCount >= 3 && a.lastErrorAt && a.lastErrorAt.getTime() > dayAgo)
      .map((a) => ({
        service: a.trashSpec.service,
        kind: a.trashSpec.kind,
        name: a.trashSpec.name,
        errorCount: a.errorCount,
        lastErrorAt: a.lastErrorAt?.toISOString() ?? null,
        lastError: a.lastError,
      }));
    report.errorStats = { failingByKind, flapping };
  } catch (err) {
    report.errorStats = { error: err instanceof Error ? err.message : String(err) };
  }

  const schemaOk =
    typeof report.tables === "object" &&
    report.tables !== null &&
    (report.tables as { TrashSpec?: boolean }).TrashSpec === true &&
    (report.tables as { TrashApplication?: boolean }).TrashApplication === true;
  const catalogPopulated =
    typeof report.counts === "object" &&
    report.counts !== null &&
    ((report.counts as { totalSpecs?: number }).totalSpecs ?? 0) > 0;

  return NextResponse.json({
    ok: schemaOk && catalogPopulated,
    summary: {
      schemaOk,
      catalogPopulated,
      starterPackResolvable:
        typeof report.starterPack === "object" &&
        report.starterPack !== null &&
        (report.starterPack as { resolved?: number }).resolved ===
          (report.starterPack as { expected?: number }).expected,
    },
    report,
  });
}

export const GET = handle;
export const POST = handle;
