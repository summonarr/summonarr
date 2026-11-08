import { NextResponse } from "next/server";
import { withCronActor } from "@/lib/cron-route";
import { prisma } from "@/lib/prisma";
import { describeSchemaError } from "@/lib/trash";
import { resolveStarterPack, STARTER_PACK } from "@/lib/trash-recommendations";

// Read-only Trash Guides diagnostic: reports schema presence, catalog counts,
// starter-pack resolution, config, and recent errors. Each probe fails on its
// own, so one failure still yields a partial report. Behind the cron gate (an
// admin or the CRON_SECRET), so a probe's error text is shown as is: naming the
// failure is the point of the endpoint.

/** A probe that threw: its message, plus a schema hint for the catalog probes. */
type ProbeError = { error: string; schemaDiagnostic?: string | null };
type Probed<T> = T | ProbeError;

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function probe<T extends object>(read: () => Promise<T>, schemaHint = false): Promise<Probed<T>> {
  try {
    return await read();
  } catch (err) {
    return schemaHint ? { error: errorText(err), schemaDiagnostic: describeSchemaError(err) } : { error: errorText(err) };
  }
}

const failed = <T extends object>(result: Probed<T>): result is ProbeError =>
  !Array.isArray(result) && "error" in result;

async function readTables() {
  const rows = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename IN ('TrashSpec', 'TrashApplication')
    ORDER BY tablename
  `;
  return {
    TrashSpec: rows.some((t) => t.tablename === "TrashSpec"),
    TrashApplication: rows.some((t) => t.tablename === "TrashApplication"),
  };
}

async function readCounts() {
  const [specCountsRaw, appCount] = await Promise.all([
    prisma.trashSpec.groupBy({ by: ["service", "kind"], _count: { _all: true } }),
    prisma.trashApplication.count(),
  ]);
  return {
    specsByService: specCountsRaw.map((c) => ({ service: c.service, kind: c.kind, count: c._count._all })),
    totalSpecs: specCountsRaw.reduce((n, c) => n + c._count._all, 0),
    totalApplications: appCount,
  };
}

function readSampleSpecs() {
  return prisma.trashSpec.findMany({
    take: 6,
    orderBy: [{ kind: "asc" }, { name: "asc" }],
    select: { id: true, service: true, kind: true, trashId: true, name: true, upstreamSha: true, fetchedAt: true },
  });
}

async function readStarterPack() {
  const starter = await resolveStarterPack();
  return {
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
}

async function readRecentAudit() {
  const audits = await prisma.auditLog.findMany({
    where: { target: { in: ["trash:refresh", "trash-sync", "trash:starter-pack", "trash:apply"] } },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { target: true, createdAt: true, details: true, userName: true },
  });
  return audits.map((a) => {
    let parsed: unknown = a.details;
    if (a.details) {
      try { parsed = JSON.parse(a.details); } catch { /* not JSON: shown as stored */ }
    }
    return { target: a.target, at: a.createdAt.toISOString(), userName: a.userName, details: parsed };
  });
}

const CONFIG_KEYS = [
  "trashGuidesEnabled",
  "trashSyncCustomFormats",
  "trashSyncQualityProfiles",
  "trashSyncNaming",
  "trashGithubToken",
  "radarrUrl",
  "radarrApiKey",
  "sonarrUrl",
  "sonarrApiKey",
] as const;
// Reported as configured/unset, never as their value.
const SENSITIVE_CONFIG_KEYS = new Set<string>(["trashGithubToken", "radarrApiKey", "sonarrApiKey"]);

async function readConfig(): Promise<Record<string, string | null>> {
  const rows = await prisma.setting.findMany({ where: { key: { in: [...CONFIG_KEYS] } }, select: { key: true, value: true } });
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return Object.fromEntries(
    CONFIG_KEYS.map((k) => [k, SENSITIVE_CONFIG_KEYS.has(k) ? (map[k] ? "configured" : "unset") : (map[k] ?? null)]),
  );
}

// When GitHub truncates the TRaSH repo file listing during a refresh, trash.ts
// saves the time here; a clean refresh deletes the row again. So no row means
// the most recent refresh was complete (an unreadable row reads the same).
async function readLastRefreshTruncatedAt(): Promise<string | null> {
  try {
    const row = await prisma.setting.findUnique({
      where: { key: "trashLastRefreshTruncatedAt" },
      select: { value: true },
    });
    return row?.value ?? null;
  } catch {
    return null;
  }
}

// failingByKind counts applied specs that currently have an error, per kind.
// "flapping" lists the ones that failed 3+ times with the latest failure in the
// last 24 hours.
async function readErrorStats() {
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
  return { failingByKind, flapping };
}

// The probes run one after another, as they always have: several share the
// same tables, and a diagnostic has no reason to take more of the pool.
async function buildReport() {
  const timestamp = new Date().toISOString();
  const tables = await probe(readTables);
  const counts = await probe(readCounts, true);
  const sampleSpecs = await probe(readSampleSpecs);
  const starterPack = await probe(readStarterPack, true);
  const recentAudit = await probe(readRecentAudit);
  const config = await probe(readConfig);
  const lastRefreshTruncatedAt = await readLastRefreshTruncatedAt();
  const errorStats = await probe(readErrorStats);
  return {
    timestamp,
    tables,
    counts,
    sampleSpecs,
    starterPack,
    recentAudit,
    config,
    ...(failed(config)
      ? {}
      : { encryption: { keySet: Boolean(process.env.TOKEN_ENCRYPTION_KEY && process.env.TOKEN_ENCRYPTION_KEY.length === 64) } }),
    lastRefreshTruncatedAt,
    errorStats,
  };
}

const handle = withCronActor(async () => {
  const report = await buildReport();
  const { tables, counts, starterPack } = report;
  const schemaOk = !failed(tables) && tables.TrashSpec && tables.TrashApplication;
  const catalogPopulated = !failed(counts) && counts.totalSpecs > 0;
  // An errored probe has neither count; comparing two undefineds used to call
  // the starter pack resolvable when its probe had thrown.
  const starterPackResolvable = !failed(starterPack) && starterPack.resolved === starterPack.expected;

  return NextResponse.json({
    ok: schemaOk && catalogPopulated,
    summary: {
      schemaOk,
      catalogPopulated,
      starterPackResolvable,
    },
    report,
  });
});

export const GET = handle;
export const POST = handle;
