// The orchestration: applySpecs runs a mixed set of specs kind by kind, and
// runTrashSync is the cron entry point (refresh, then apply on every instance).
import { prisma } from "./prisma";
import type { ArrVariant } from "./arr";
import { getSyncableArrInstances } from "./arr-instance-registry";
import { applyCustomFormatGroupsWithMembers, applyCustomFormats, groupMemberTrashIds } from "./trash-apply-cf";
import { applyNaming, applyQualitySizes } from "./trash-apply-config";
import { applyQualityProfiles } from "./trash-apply-profile";
import { formatArrError, recordAllFailed, storedPayload, toApplyResult, toArrInstance } from "./trash-apply-common";
import { fetchTrashTree, type TrashTree } from "./trash-github";
import { refreshCatalog, type RefreshResult } from "./trash-refresh";
import { isCustomFormatGroupPayload } from "./trash-validators";
import { foldedApplyError } from "./trash-sync-text";
import type { ApplyOptions, ApplyResult, SpecIdentity } from "./trash-types";
import type { TrashService, TrashSpecKind } from "@/generated/prisma";

// CF-Groups must run before CUSTOM_FORMAT (groups cascade to members) and before QUALITY_PROFILE
// (profiles depend on member CFs being present in Arr); naming and quality-sizes are independent.
const APPLY_ORDER: readonly TrashSpecKind[] = [
  "CUSTOM_FORMAT_GROUP",
  "CUSTOM_FORMAT",
  "QUALITY_PROFILE",
  "NAMING",
  "QUALITY_SIZE",
];

// The results for one applySpecs kind group whose apply threw before it could
// record per-spec outcomes. An unconfigured instance is answered without a DB
// write (no stray TrashApplication rows for an instance that doesn't exist);
// any other failure is recorded against each spec, as a per-spec failure is.
async function failedGroupResults(
  specs: readonly SpecIdentity[],
  err: unknown,
  arrInstance: string,
): Promise<ApplyResult[]> {
  const error = formatArrError(err);
  if (err instanceof Error && err.name === "ArrNotConfiguredError") {
    return specs.map((spec) => toApplyResult(spec, { ok: false, error }));
  }
  return recordAllFailed(specs, error, arrInstance);
}

type SpecRow = SpecIdentity & { service: TrashService; payload: unknown };

function appendTo<K>(map: Map<K, string[]>, key: K, id: string): void {
  const list = map.get(key);
  if (list) list.push(id);
  else map.set(key, [id]);
}

// The CUSTOM_FORMAT specs a requested CF-Group of the same service lists: a
// group's apply cascade pushes them, so a standalone apply would double the
// Radarr/Sonarr round-trips.
async function cfSpecsCascadedByGroups(specs: readonly SpecRow[]): Promise<Set<string>> {
  const memberTrashIdsByService = new Map<TrashService, Set<string>>();
  for (const g of specs) {
    if (g.kind !== "CUSTOM_FORMAT_GROUP") continue;
    const set = memberTrashIdsByService.get(g.service) ?? new Set<string>();
    for (const id of groupMemberTrashIds(storedPayload(g, isCustomFormatGroupPayload))) set.add(id);
    memberTrashIdsByService.set(g.service, set);
  }
  const cascaded = new Set<string>();
  if (memberTrashIdsByService.size === 0) return cascaded;
  const allMemberTrashIds = [...memberTrashIdsByService.values()].flatMap((s) => [...s]);
  const memberCfSpecs = await prisma.trashSpec.findMany({
    where: { kind: "CUSTOM_FORMAT", trashId: { in: allMemberTrashIds } },
    select: { id: true, service: true, trashId: true },
  });
  for (const m of memberCfSpecs) {
    if (memberTrashIdsByService.get(m.service)?.has(m.trashId)) cascaded.add(m.id);
  }
  return cascaded;
}

// One (service, kind) group's apply. The CF-Group phase answers for the member
// CFs it pushed as well.
async function applyKind(
  service: TrashService,
  kind: TrashSpecKind,
  ids: string[],
  variant: ArrVariant,
  opts: ApplyOptions,
): Promise<ApplyResult[]> {
  switch (kind) {
    case "CUSTOM_FORMAT_GROUP": {
      const { groups, members } = await applyCustomFormatGroupsWithMembers(service, ids, variant, opts);
      return [...groups, ...members];
    }
    case "CUSTOM_FORMAT":
      return applyCustomFormats(service, ids, variant, opts);
    case "QUALITY_PROFILE":
      return applyQualityProfiles(service, ids, variant, opts);
    case "NAMING":
      return applyNaming(service, ids, variant);
    case "QUALITY_SIZE":
      return applyQualitySizes(service, ids, variant);
  }
}

// Applies a mixed set of specs by kind in dependency order (groups → CFs → profiles → naming → sizes), deduping CFs already cascaded by a group.
// Each (service, kind) group is contained: one that throws (its instance not
// configured, its arr unreachable mid-read) answers ok:false for its own specs
// and the rest still run, so the caller can return and audit what was written.
// A member CF a group pushed is reported once, with its group. The lock's
// signal (guardrail 41) is checked between groups and inside each applier; an
// aborted apply returns what it did.
export async function applySpecs(
  specIds: string[],
  variant: ArrVariant = "hd",
  opts: ApplyOptions = {},
): Promise<ApplyResult[]> {
  const arrInstance = toArrInstance(variant);
  const specs: SpecRow[] = await prisma.trashSpec.findMany({
    where: { id: { in: specIds } },
    select: { id: true, service: true, kind: true, trashId: true, name: true, payload: true },
  });
  const specById = new Map(specs.map((s) => [s.id, s]));
  const cascaded = await cfSpecsCascadedByGroups(specs);

  // kind → service → spec ids, services in first-seen order.
  const byKind = new Map<TrashSpecKind, Map<TrashService, string[]>>();
  // Requested CFs a group of their service will push, answered with that group.
  const cascadedByService = new Map<TrashService, string[]>();
  for (const s of specs) {
    if (s.kind === "CUSTOM_FORMAT" && cascaded.has(s.id)) {
      appendTo(cascadedByService, s.service, s.id);
      continue;
    }
    let byService = byKind.get(s.kind);
    if (!byService) byKind.set(s.kind, (byService = new Map()));
    appendTo(byService, s.service, s.id);
  }

  const all: ApplyResult[] = [];
  for (const kind of APPLY_ORDER) {
    for (const [service, ids] of byKind.get(kind) ?? []) {
      if (opts.signal?.aborted) return all;
      try {
        all.push(...(await applyKind(service, kind, ids, variant, opts)));
      } catch (err) {
        // A group phase that threw pushed none of its members either.
        const unanswered = kind === "CUSTOM_FORMAT_GROUP" ? cascadedByService.get(service) ?? [] : [];
        const failed = [...ids, ...unanswered].flatMap((id) => {
          const spec = specById.get(id);
          return spec ? [spec] : [];
        });
        all.push(...(await failedGroupResults(failed, err, arrInstance)));
      }
    }
  }
  return all;
}

export interface TrashSyncResult {
  refreshed: RefreshResult[];
  applied: ApplyResult[];
  errors: string[];
}

// Cap refresh frequency regardless of how often the cron fires. Admin "Refresh Catalog" button
// bypasses this — it's an explicit user action that should always hit GitHub.
const REFRESH_MIN_INTERVAL_MS = 60 * 60 * 1000;

const SERVICES: readonly TrashService[] = ["RADARR", "SONARR"];

const SYNC_SETTING_KEYS = [
  "trashGuidesEnabled",
  "trashSyncCustomFormats",
  "trashSyncCustomFormatGroups",
  "trashSyncQualityProfiles",
  "trashSyncNaming",
  "trashSyncQualitySizes",
  "trashLastRefreshAt",
] as const;
type SyncSettings = Partial<Record<(typeof SYNC_SETTING_KEYS)[number], string>>;

async function loadSyncSettings(): Promise<SyncSettings> {
  const rows = await prisma.setting.findMany({ where: { key: { in: [...SYNC_SETTING_KEYS] } } });
  return Object.fromEntries(rows.map((s) => [s.key, s.value]));
}

// Cadence gate: if a refresh ran within the last hour, skip the GitHub round-trip and run apply
// alone. Lets users set TRASH_SYNC_INTERVAL more aggressively (e.g. every 15 minutes) for faster
// apply-after-edit feedback without hammering GitHub.
function isRefreshDue(lastRefreshAt: string | undefined, now: number): boolean {
  const last = lastRefreshAt ? Date.parse(lastRefreshAt) : NaN;
  return Number.isNaN(last) || now - last > REFRESH_MIN_INTERVAL_MS;
}

// Every kind the admin hasn't switched off.
function enabledSyncKinds(settings: SyncSettings): TrashSpecKind[] {
  const kinds: TrashSpecKind[] = [];
  if (settings.trashSyncCustomFormats !== "false") kinds.push("CUSTOM_FORMAT");
  if (settings.trashSyncCustomFormatGroups !== "false") kinds.push("CUSTOM_FORMAT_GROUP");
  if (settings.trashSyncNaming !== "false") kinds.push("NAMING");
  if (settings.trashSyncQualityProfiles !== "false") kinds.push("QUALITY_PROFILE");
  if (settings.trashSyncQualitySizes !== "false") kinds.push("QUALITY_SIZE");
  return kinds;
}

// Refreshes both services off ONE shared tree fetch — the ~573 KB recursive
// listing is identical for RADARR and SONARR, so fetching it per service doubled
// the GitHub transfer every cycle. A tree-fetch failure fails both services'
// refresh (errors pushed per service, nothing refreshed). Each service's own
// failure is contained to it.
async function refreshServices(signal: AbortSignal | undefined, errors: string[]): Promise<RefreshResult[]> {
  let tree: TrashTree;
  try {
    tree = await fetchTrashTree();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    for (const service of SERVICES) errors.push(`${service} refresh: ${msg}`);
    return [];
  }
  const refreshed: RefreshResult[] = [];
  for (const service of SERVICES) {
    if (signal?.aborted) break;
    try {
      const r = await refreshCatalog(service, tree, { signal });
      refreshed.push(r);
      errors.push(...r.errors.map((e) => `${service}: ${e}`));
    } catch (err) {
      errors.push(`${service} refresh: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return refreshed;
}

async function stampLastRefresh(): Promise<void> {
  const value = new Date().toISOString();
  await prisma.setting.upsert({
    where: { key: "trashLastRefreshAt" },
    update: { value },
    create: { key: "trashLastRefreshAt", value },
  }).catch((err) => {
    console.warn("[trash] failed to stamp last-refresh-at:", err instanceof Error ? err.message : err);
  });
}

// Applies each configured instance independently. A named/4K instance does nothing unless an admin
// has created applications for its slug (only possible once that instance is configured), so a
// single-instance deployment only ever runs the default ("") pass. We loop per service so a
// service's specs only target that service's instances.
async function applyEveryInstance(
  kinds: TrashSpecKind[],
  signal: AbortSignal | undefined,
  errors: string[],
): Promise<ApplyResult[]> {
  const applied: ApplyResult[] = [];
  for (const service of SERVICES) {
    if (signal?.aborted) break;
    const instances = await getSyncableArrInstances(service === "RADARR" ? "radarr" : "sonarr");
    for (const inst of instances) {
      // Return, never throw, on abort: withAdvisoryLock's race has already
      // settled on the timeout rejection and a throw here would be unhandled.
      if (signal?.aborted) break;
      // Per-instance containment, mirroring the refresh: one instance's thrown
      // apply (its arr down mid-batch, a DB blip) must not abort every
      // remaining instance's — and the other service's — applies.
      try {
        const applications = await prisma.trashApplication.findMany({
          where: { enabled: true, arrInstance: inst.slug, trashSpec: { service, kind: { in: kinds } } },
          select: { trashSpecId: true },
        });
        if (applications.length === 0) continue;
        applied.push(...(await applySpecs(applications.map((a) => a.trashSpecId), inst.slug, { signal })));
      } catch (err) {
        errors.push(`${service}${inst.slug ? ` (${inst.slug})` : ""} apply: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return applied;
}

// Cron entry point: refreshes the catalog from GitHub (gated to hourly) when enabled, then applies all enabled specs across every configured instance per service.
// `signal` is the advisory lock's AbortSignal (guardrail 41): the refresh stops
// at its next GitHub download batch, and the apply phase between specs,
// returning the partial result. Never keep working lock-free beside the retry
// the entrypoint schedules.
export async function runTrashSync(opts: { signal?: AbortSignal } = {}): Promise<TrashSyncResult> {
  const settings = await loadSyncSettings();
  if (settings.trashGuidesEnabled !== "true") {
    return { refreshed: [], applied: [], errors: ["trashGuidesEnabled is off"] };
  }

  const errors: string[] = [];
  let refreshed: RefreshResult[] = [];
  if (isRefreshDue(settings.trashLastRefreshAt, Date.now())) {
    refreshed = await refreshServices(opts.signal, errors);
    // Stamp only a refresh where EVERY service ran to the end: a service whose
    // refresh threw, or a pass the lock's signal cut short, is retried by the
    // next run instead of sitting out the cadence window.
    const aborted = opts.signal?.aborted === true || refreshed.some((r) => r.aborted);
    if (refreshed.length === SERVICES.length && !aborted) await stampLastRefresh();
  }

  const applied = await applyEveryInstance(enabledSyncKinds(settings), opts.signal, errors);
  for (const r of applied) {
    if (!r.ok && r.error) errors.push(foldedApplyError(r.trashId, r.error));
  }
  return { refreshed, applied, errors };
}
