import { NextRequest, NextResponse } from "next/server";
import { isCronAuthorized } from "@/lib/cron-auth";
import { prisma } from "@/lib/prisma";
import { describeSchemaError } from "@/lib/trash";
import { resolveStarterPack, STARTER_PACK } from "@/lib/trash-recommendations";

// Read-only Trash Guides diagnostic: reports schema presence, catalog counts,
// starter-pack resolution, config, and recent errors. Each probe is independently
// try/caught so one failure still yields a partial report.
async function handle(request: NextRequest) {
  if (!(await isCronAuthorized(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const report: Record<string, unknown> = { timestamp: new Date().toISOString() };

  // The three probes the summary is derived from keep their own types, so an
  // errored probe narrows to its `{ error }` shape and always reads as a failure.
  type ProbeError = { error: string; schemaDiagnostic?: string | null };
  const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

  let tables: { TrashSpec: boolean; TrashApplication: boolean } | ProbeError;
  try {
    const rows = await prisma.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename IN ('TrashSpec', 'TrashApplication')
      ORDER BY tablename
    `;
    tables = {
      TrashSpec: rows.some((t) => t.tablename === "TrashSpec"),
      TrashApplication: rows.some((t) => t.tablename === "TrashApplication"),
    };
  } catch (err) {
    tables = { error: errorText(err) };
  }
  report.tables = tables;

  let counts:
    | {
        specsByService: Array<{ service: string; kind: string; count: number }>;
        totalSpecs: number;
        totalApplications: number;
      }
    | ProbeError;
  try {
    const [specCountsRaw, appCount] = await Promise.all([
      prisma.trashSpec.groupBy({ by: ["service", "kind"], _count: { _all: true } }),
      prisma.trashApplication.count(),
    ]);
    counts = {
      specsByService: specCountsRaw.map((c) => ({ service: c.service, kind: c.kind, count: c._count._all })),
      totalSpecs: specCountsRaw.reduce((n, c) => n + c._count._all, 0),
      totalApplications: appCount,
    };
  } catch (err) {
    counts = { error: errorText(err), schemaDiagnostic: describeSchemaError(err) };
  }
  report.counts = counts;

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

  let starterPack:
    | { expected: number; resolved: number; missing: unknown[]; resolvedDetails: unknown[] }
    | ProbeError;
  try {
    const starter = await resolveStarterPack();
    starterPack = {
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
    starterPack = { error: errorText(err), schemaDiagnostic: describeSchemaError(err) };
  }
  report.starterPack = starterPack;

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

  // When GitHub truncates the TRaSH repo file listing during a refresh, trash.ts
  // saves the time here; a clean refresh deletes the row again. So no row means
  // the most recent refresh was complete.
  try {
    const truncRow = await prisma.setting.findUnique({
      where: { key: "trashLastRefreshTruncatedAt" },
      select: { value: true },
    });
    report.lastRefreshTruncatedAt = truncRow?.value ?? null;
  } catch {
    report.lastRefreshTruncatedAt = null;
  }

  // Error stats. failingByKind counts applied specs that currently have an
  // error, per kind. "flapping" lists the ones that failed 3+ times with the
  // latest failure in the last 24 hours.
  try {
    const failingApps = await prisma.trashApplication.findMany({
      where: { lastError: { not: null } },
      select: {
        trashSpec: { select: { kind: true, name: true, service: true } },
        arrInstance: true,
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
        variant: a.arrInstance === "" ? "hd" : a.arrInstance,
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

  const schemaOk = !("error" in tables) && tables.TrashSpec && tables.TrashApplication;
  const catalogPopulated = !("error" in counts) && counts.totalSpecs > 0;
  // An errored probe has neither count; comparing two undefineds used to call
  // the starter pack resolvable when its probe had thrown.
  const starterPackResolvable = !("error" in starterPack) && starterPack.resolved === starterPack.expected;

  return NextResponse.json({
    ok: schemaOk && catalogPopulated,
    summary: {
      schemaOk,
      catalogPopulated,
      starterPackResolvable,
    },
    report,
  });
}

export const GET = handle;
export const POST = handle;
