// The catalog refresh: TRaSH-Guides files from GitHub → TrashSpec rows, one
// pass per spec kind, then the retirement of specs the upstream tree dropped.
import { prisma } from "./prisma";
import { BATCH_TX_TIMEOUT } from "./batch-write";
import { fetchTrashFile, fetchTrashTree, setRefreshTruncated, type GhTreeEntry, type TrashTree } from "./trash-github";
import { isSchemaError } from "./trash-schema-error";
import {
  isCustomFormatPayload,
  isCustomFormatGroupPayload,
  isNamingPayload,
  isQualityProfilePayload,
  isQualitySizePayload,
} from "./trash-validators";
import type { TrashService, TrashSpecKind } from "@/generated/prisma";

const GH_CONCURRENCY = 8;

const TRASH_PATHS: Record<TrashService, {
  cf: string;
  cfGroups: string;
  naming: string;
  qualityProfiles: string;
  qualitySizes: string;
}> = {
  RADARR: {
    cf: "docs/json/radarr/cf",
    cfGroups: "docs/json/radarr/cf-groups",
    naming: "docs/json/radarr/naming/radarr-naming.json",
    qualityProfiles: "docs/json/radarr/quality-profiles",
    qualitySizes: "docs/json/radarr/quality-size",
  },
  SONARR: {
    cf: "docs/json/sonarr/cf",
    cfGroups: "docs/json/sonarr/cf-groups",
    naming: "docs/json/sonarr/naming/sonarr-naming.json",
    qualityProfiles: "docs/json/sonarr/quality-profiles",
    qualitySizes: "docs/json/sonarr/quality-size",
  },
};

export interface RefreshResult {
  service: TrashService;
  // `fetched` counts every upstream file of the kind that is accounted for:
  // downloaded and valid, or skipped WITHOUT a download because its tree entry
  // (path + blob sha) is exactly the stored row's. `unchanged` is the part of
  // `fetched` that needed no write.
  customFormats: { fetched: number; updated: number; unchanged: number };
  customFormatGroups: { fetched: number; updated: number; unchanged: number };
  naming: { fetched: number; updated: number };
  qualityProfiles: { fetched: number; updated: number };
  qualitySizes: { fetched: number; updated: number };
  errors: string[];
  // Count of upstream files rejected by hand-rolled type guards (see trash-validators.ts). Skipped
  // specs keep their prior good upstreamSha so the next refresh re-attempts them. Surfaced in the
  // diagnostic endpoint so silent rejections become visible.
  validationSkipped?: number;
  // Catalog specs whose trash_id the upstream tree no longer carries (removed or
  // re-keyed upstream): `deleted` specs had no application at all; `disabled`
  // counts applications switched off so the sync stops pushing the stale
  // definition. Present only when something was pruned.
  removedUpstream?: { deleted: number; disabled: number };
  // The lock's AbortSignal stopped the pass early (guardrail 41). A partial pass
  // prunes nothing.
  aborted?: true;
}

// Thrown inside a file fetch when the payload fails its type guard — counted
// as validationSkipped, unlike a network or JSON failure.
class PayloadShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayloadShapeError";
  }
}

type KindCounts = { fetched: number; updated: number; unchanged: number };

// What a refreshed kind left behind: the counts, the trash_ids the upstream tree
// still carries, and whether that set is trustworthy enough to prune by.
interface KindPass {
  counts: KindCounts;
  seen: Set<string>;
  complete: boolean;
}

interface StoredSpec {
  id: string;
  kind: TrashSpecKind;
  trashId: string;
  upstreamSha: string | null;
  upstreamPath: string;
}

interface RefreshContext {
  service: TrashService;
  tree: GhTreeEntry[];
  // `${kind}::${path}::${sha}` → the trash_id of the stored row whose content
  // is exactly that blob. A tree entry found here needs no download, and a
  // downloaded file never matches a stored row's path and sha.
  storedByBlob: Map<string, string>;
  now: Date;
  errors: string[];
  // Validator rejections, counted across every kind's pass.
  validation: { skipped: number };
  signal?: AbortSignal;
}

// Stored on an application whose spec the upstream catalog no longer carries.
const REMOVED_UPSTREAM_ERROR =
  "Removed from the TRaSH Guides catalog upstream, so it is no longer applied. Delete this application to drop the spec.";

const blobKey = (kind: TrashSpecKind, path: string, sha: string) => `${kind}::${path}::${sha}`;

// Pulls the TRaSH-Guides tree from GitHub and upserts every spec kind (CFs, CF-groups, naming, profiles, sizes) for one service into TrashSpec.
// `prefetchedTree` lets a caller refreshing BOTH services share one ~573 KB
// recursive tree fetch instead of pulling the identical tree back-to-back.
// `signal` (the advisory lock's, guardrail 41) is checked at every download
// batch: an aborted pass returns what it did, marked `aborted`, and prunes nothing.
export async function refreshCatalog(
  service: TrashService,
  prefetchedTree?: TrashTree,
  opts: { signal?: AbortSignal } = {},
): Promise<RefreshResult> {
  const now = new Date();
  const { entries, truncated } = prefetchedTree ?? await fetchTrashTree();
  // Persist truncation state so the admin UI / diagnostic can surface it. Failure to persist must
  // not block the refresh itself — the warn log is still emitted when the tree is read.
  await setRefreshTruncated(truncated).catch((err) => {
    console.warn("[trash] failed to persist truncation state:", err instanceof Error ? err.message : err);
  });

  const existing: StoredSpec[] = await prisma.trashSpec.findMany({
    where: { service },
    select: { id: true, kind: true, trashId: true, upstreamSha: true, upstreamPath: true },
  });
  const ctx: RefreshContext = {
    service,
    tree: entries,
    storedByBlob: storedBlobIndex(existing),
    now,
    errors: [],
    validation: { skipped: 0 },
    signal: opts.signal,
  };
  const passes = await refreshEveryKind(ctx);

  const aborted = opts.signal?.aborted === true;
  // Prune only from a listing that is whole (not truncated) and a pass that read
  // all of it: a kind with any fetch/parse/validation/write error, or no files
  // listed at all (a moved upstream directory reads as empty), keeps every row.
  let removedUpstream: { deleted: number; disabled: number } | null = null;
  if (!aborted && !truncated) {
    const pruned = await pruneRemovedSpecs(unseenSpecIds(existing, passes.byKind), now);
    if (pruned.deleted > 0 || pruned.disabled > 0) removedUpstream = pruned;
  }

  const { cf, cfg, qp, qs } = passes;
  return {
    service,
    customFormats: cf.counts,
    customFormatGroups: cfg.counts,
    naming: passes.naming,
    qualityProfiles: { fetched: qp.counts.fetched, updated: qp.counts.updated },
    qualitySizes: { fetched: qs.counts.fetched, updated: qs.counts.updated },
    errors: ctx.errors,
    ...(ctx.validation.skipped > 0 ? { validationSkipped: ctx.validation.skipped } : {}),
    ...(removedUpstream ? { removedUpstream } : {}),
    ...(aborted ? { aborted: true as const } : {}),
  };
}

function storedBlobIndex(existing: StoredSpec[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const s of existing) {
    if (s.upstreamSha !== null) index.set(blobKey(s.kind, s.upstreamPath, s.upstreamSha), s.trashId);
  }
  return index;
}

// Every kind's pass, in order: CF-Groups refresh AFTER CFs so member trash_ids
// resolve against fresh spec rows.
async function refreshEveryKind(ctx: RefreshContext) {
  const paths = TRASH_PATHS[ctx.service];
  const cf = await refreshDir(ctx, {
    kind: "CUSTOM_FORMAT",
    dir: paths.cf,
    label: "cf",
    validate: isCustomFormatPayload,
    toRow: (p) => ({ trashId: p.trash_id, name: p.name }),
  });
  const cfg = await refreshDir(ctx, {
    kind: "CUSTOM_FORMAT_GROUP",
    dir: paths.cfGroups,
    label: "cf-group",
    validate: isCustomFormatGroupPayload,
    toRow: (p) => ({ trashId: p.trash_id, name: p.name, description: p.trash_description ?? null }),
  });
  const naming = await refreshNaming(ctx);
  const qp = await refreshDir(ctx, {
    kind: "QUALITY_PROFILE",
    dir: paths.qualityProfiles,
    label: "profile",
    validate: isQualityProfilePayload,
    toRow: (p) => ({ trashId: p.trash_id, name: p.name }),
  });
  const qs = await refreshDir(ctx, {
    kind: "QUALITY_SIZE",
    dir: paths.qualitySizes,
    label: "quality-size",
    validate: isQualitySizePayload,
    // A size file's `type` is optional; the file name stands in for it.
    toRow: (p, file) => ({ trashId: p.trash_id, name: p.type || fileSlug(file.path) }),
  });
  const byKind = new Map<TrashSpecKind, KindPass>([
    ["CUSTOM_FORMAT", cf],
    ["CUSTOM_FORMAT_GROUP", cfg],
    ["QUALITY_PROFILE", qp],
    ["QUALITY_SIZE", qs],
  ]);
  return { cf, cfg, naming, qp, qs, byKind };
}

// Stored specs of a kind whose pass was complete and never saw their trash_id.
function unseenSpecIds(existing: StoredSpec[], passes: Map<TrashSpecKind, KindPass>): string[] {
  return existing
    .filter((s) => {
      const pass = passes.get(s.kind);
      return pass !== undefined && pass.complete && !pass.seen.has(s.trashId);
    })
    .map((s) => s.id);
}

function fileSlug(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1).replace(/\.json$/, "");
}

interface DirDef<T> {
  kind: TrashSpecKind;
  dir: string;
  // Prefix of this kind's lines in RefreshResult.errors.
  label: string;
  validate: (v: unknown) => v is T;
  toRow: (parsed: T, file: GhTreeEntry) => { trashId: string; name: string; description?: string | null };
}

interface SpecWrite {
  trashId: string;
  name: string;
  description?: string | null;
  payload: unknown;
  path: string;
  sha: string;
}

// One spec kind's directory: skip every file whose blob is already stored,
// download the rest GH_CONCURRENCY at a time, validate, and upsert each batch's
// rows in one transaction (sequential awaits, BATCH_TX_TIMEOUT — guardrails
// 4/23c). A validator reject, a failed download or a failed write stores
// nothing for those files, so their old sha stays and the next refresh retries.
async function refreshDir<T>(ctx: RefreshContext, def: DirDef<T>): Promise<KindPass> {
  const files = ctx.tree.filter(
    (t) => t.type === "blob" && t.path.startsWith(`${def.dir}/`) && t.path.endsWith(".json"),
  );
  const counts: KindCounts = { fetched: 0, updated: 0, unchanged: 0 };
  const seen = new Set<string>();
  let complete = files.length > 0;

  const toFetch: GhTreeEntry[] = [];
  for (const f of files) {
    const storedTrashId = ctx.storedByBlob.get(blobKey(def.kind, f.path, f.sha));
    if (storedTrashId !== undefined) {
      counts.fetched++;
      counts.unchanged++;
      seen.add(storedTrashId);
    } else {
      toFetch.push(f);
    }
  }

  for (let i = 0; i < toFetch.length; i += GH_CONCURRENCY) {
    if (ctx.signal?.aborted) {
      complete = false;
      break;
    }
    const batch = await downloadBatch(def, toFetch.slice(i, i + GH_CONCURRENCY));
    if (!collectBatch(ctx, def, batch, counts, seen)) complete = false;
    const rows = batch.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    if (rows.length === 0) continue;
    if (await writeBatch(ctx, def, rows)) counts.updated += rows.length;
    else complete = false;
  }

  return { counts, seen, complete };
}

// Downloads, parses and validates one batch of files, each settled on its own.
function downloadBatch<T>(def: DirDef<T>, batch: GhTreeEntry[]): Promise<PromiseSettledResult<SpecWrite>[]> {
  return Promise.allSettled(
    batch.map(async (f) => {
      const parsedRaw = JSON.parse(await fetchTrashFile(f.path)) as unknown;
      // Validate shape against the apply-path's contract — malformed payloads are skipped so the
      // prior good upstreamSha is preserved for the next refresh attempt.
      if (!def.validate(parsedRaw)) {
        throw new PayloadShapeError(`${def.label} payload shape mismatch: ${f.path}`);
      }
      return { ...def.toRow(parsedRaw, f), payload: parsedRaw, path: f.path, sha: f.sha };
    }),
  );
}

// Counts a downloaded batch and reports each failed file. False when any failed.
function collectBatch<T>(
  ctx: RefreshContext,
  def: DirDef<T>,
  batch: PromiseSettledResult<SpecWrite>[],
  counts: KindCounts,
  seen: Set<string>,
): boolean {
  let whole = true;
  for (const r of batch) {
    if (r.status === "fulfilled") {
      counts.fetched++;
      seen.add(r.value.trashId);
      continue;
    }
    whole = false;
    if (r.reason instanceof PayloadShapeError) ctx.validation.skipped++;
    const message = r.reason instanceof Error ? r.reason.message : String(r.reason);
    ctx.errors.push(`${def.label}: ${message}`);
  }
  return whole;
}

// Upserts one batch in a single transaction. A missing table or enum value is
// thrown (every later write would fail the same way, and the callers turn it
// into the db-push hint); any other failure is reported for these files and the
// refresh goes on with the next batch.
async function writeBatch<T>(ctx: RefreshContext, def: DirDef<T>, rows: SpecWrite[]): Promise<boolean> {
  try {
    await prisma.$transaction(async (tx) => {
      for (const row of rows) {
        const fields = {
          name: row.name,
          ...(row.description !== undefined ? { description: row.description } : {}),
          payload: row.payload as object,
          upstreamPath: row.path,
          upstreamSha: row.sha,
          fetchedAt: ctx.now,
        };
        await tx.trashSpec.upsert({
          where: { service_kind_trashId: { service: ctx.service, kind: def.kind, trashId: row.trashId } },
          update: fields,
          create: { service: ctx.service, kind: def.kind, trashId: row.trashId, ...fields },
        });
      }
    }, { timeout: BATCH_TX_TIMEOUT });
    return true;
  } catch (err) {
    reportWriteFailure(ctx, def.label, rows.length, err);
    return false;
  }
}

// The DB error's text can name the database host or a query: it goes to the
// log, and the refresh result (shown to admins, audited) gets a plain line.
function reportWriteFailure(ctx: RefreshContext, label: string, count: number, err: unknown): void {
  if (isSchemaError(err)) throw err;
  console.error(`[trash] ${ctx.service} ${label} write failed:`, err);
  ctx.errors.push(`${label}: could not save ${count} spec(s) to the database (see the server log)`);
}

async function refreshNaming(ctx: RefreshContext): Promise<{ fetched: number; updated: number }> {
  const path = TRASH_PATHS[ctx.service].naming;
  const file = ctx.tree.find((t) => t.type === "blob" && t.path === path);
  if (!file) {
    ctx.errors.push(`naming: upstream file missing (${path})`);
    return { fetched: 0, updated: 0 };
  }
  const trashId = "default";
  if (ctx.storedByBlob.get(blobKey("NAMING", file.path, file.sha)) === trashId) {
    return { fetched: 1, updated: 0 };
  }
  if (ctx.signal?.aborted) return { fetched: 0, updated: 0 };

  let raw: string;
  try {
    raw = await fetchTrashFile(file.path);
  } catch (err) {
    ctx.errors.push(`naming: ${err instanceof Error ? err.message : String(err)}`);
    return { fetched: 0, updated: 0 };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (err) {
    ctx.errors.push(`naming: parse failed ${err instanceof Error ? err.message : String(err)}`);
    return { fetched: 0, updated: 0 };
  }
  if (!isNamingPayload(parsed)) {
    ctx.validation.skipped++;
    ctx.errors.push(`naming: payload shape mismatch (${file.path})`);
    return { fetched: 1, updated: 0 };
  }

  const fields = {
    name: "TRaSH Standard Naming",
    payload: parsed as object,
    upstreamPath: file.path,
    upstreamSha: file.sha,
    fetchedAt: ctx.now,
  };
  try {
    await prisma.trashSpec.upsert({
      where: { service_kind_trashId: { service: ctx.service, kind: "NAMING", trashId } },
      update: fields,
      create: { service: ctx.service, kind: "NAMING", trashId, ...fields },
    });
  } catch (err) {
    reportWriteFailure(ctx, "naming", 1, err);
    return { fetched: 1, updated: 0 };
  }
  return { fetched: 1, updated: 1 };
}

// Retires specs the upstream catalog dropped. A spec nobody ever applied is
// deleted. One that has applications is KEPT, and its enabled applications are
// switched off with an explanation, so the sync stops pushing a definition
// TRaSH withdrew while the admin can still see what happened; deleting the
// application lets the next refresh drop the spec. Nothing here cascades an
// application away (TrashApplication is onDelete: Cascade).
async function pruneRemovedSpecs(
  specIds: string[],
  now: Date,
): Promise<{ deleted: number; disabled: number }> {
  if (specIds.length === 0) return { deleted: 0, disabled: 0 };
  const apps = await prisma.trashApplication.findMany({
    where: { trashSpecId: { in: specIds } },
    select: { trashSpecId: true },
  });
  const applied = new Set(apps.map((a) => a.trashSpecId));
  const keep = specIds.filter((id) => applied.has(id));
  const drop = specIds.filter((id) => !applied.has(id));
  return prisma.$transaction(async (tx) => {
    let disabled = 0;
    if (keep.length > 0) {
      const r = await tx.trashApplication.updateMany({
        where: { trashSpecId: { in: keep }, enabled: true },
        data: { enabled: false, lastError: REMOVED_UPSTREAM_ERROR, lastErrorAt: now },
      });
      disabled = r.count;
    }
    let deleted = 0;
    if (drop.length > 0) {
      // `none` re-checks inside the write, so an application created since the
      // read above keeps its spec.
      const r = await tx.trashSpec.deleteMany({
        where: { id: { in: drop }, applications: { none: {} } },
      });
      deleted = r.count;
    }
    return { deleted, disabled };
  }, { timeout: BATCH_TX_TIMEOUT });
}
