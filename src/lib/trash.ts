import { prisma } from "./prisma";
import { safeFetchTrusted } from "./safe-fetch";
import { arrFetch, ArrResponseError, getArrCfg, type ArrCfg, type ArrVariant } from "./arr";
import { getSyncableArrInstances } from "./arr-instance-registry";
import { BATCH_TX_TIMEOUT } from "./cron-auth";
import { mapLimit } from "./concurrency";
import {
  isCustomFormatPayload,
  isCustomFormatGroupPayload,
  isNamingPayload,
  isQualityProfilePayload,
  isQualitySizePayload,
} from "./trash-validators";
import type { TrashService, TrashSpecKind } from "@/generated/prisma";
import { isPrismaErrorCode } from "@/lib/prisma-errors";

// Maps a raw DB error to an actionable "run prisma db push" hint when trash tables/enum values are missing; null otherwise.
export function describeSchemaError(err: unknown): string | null {
  if (!(err instanceof Error)) return null;
  const message = err.message;
  if (/relation "(public\.)?"?Trash(Spec|Application)"? does not exist/i.test(message)) {
    return (
      "TrashSpec/TrashApplication tables are missing in the database. " +
      "Run `npx prisma db push` against DATABASE_URL to apply the schema " +
      "(the production entrypoint does this on container start — rebuild + restart)."
    );
  }
  if ((err as { code?: string }).code === "42P01") {
    return (
      "A Postgres relation referenced by trash-sync does not exist yet. " +
      "Run `npx prisma db push` to apply the latest schema."
    );
  }
  if (/invalid input value for enum.*TrashSpecKind.*CUSTOM_FORMAT_GROUP/i.test(message)) {
    return (
      "TrashSpecKind enum is missing CUSTOM_FORMAT_GROUP. Run `npx prisma db push` " +
      "to add the new enum value before refreshing CF-Groups."
    );
  }
  return null;
}

const TRASH_REPO = "TRaSH-Guides/Guides";
const TRASH_BRANCH = "master";
const USER_AGENT = "Summonarr-TrashSync/0.1";

const RAW_FETCH_MAX_BYTES = 2 * 1024 * 1024;
const TREE_FETCH_TIMEOUT_MS = 30_000;
const RAW_FETCH_TIMEOUT_MS = 15_000;
const GH_CONCURRENCY = 8;
// Bounds the recordApply() fan-out on the prefetch-failure path (guardrail 31)
// — an admin can have applied hundreds of custom formats/quality profiles, and
// each recordApply is its own Prisma upsert.
const RECORD_APPLY_CONCURRENCY = 8;

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

interface GhTreeEntry {
  path: string;
  sha: string;
  type: string;
}

export interface TrashCustomFormat {
  trash_id: string;
  trash_scores?: Record<string, number>;
  name: string;
  includeCustomFormatWhenRenaming?: boolean;
  specifications?: unknown[];
  [k: string]: unknown;
}

export interface TrashCustomFormatGroupMember {
  name: string;
  trash_id: string;
  required: boolean;
}

export interface TrashCustomFormatGroup {
  trash_id: string;
  name: string;
  trash_description?: string;
  default?: string;
  custom_formats: TrashCustomFormatGroupMember[];
  quality_profiles?: { include?: Record<string, string> };
  [k: string]: unknown;
}

export interface TrashQualitySize {
  trash_id: string;
  type?: string;
  qualities: Array<{
    quality: string;
    min: number;
    preferred?: number;
    max: number;
  }>;
}

export interface TrashQualityProfile {
  trash_id: string;
  trash_description?: string;
  trash_url?: string;
  name: string;
  upgradeAllowed?: boolean;
  cutoff?: string;
  cutoffFormatScore?: number;
  minFormatScore?: number;
  minUpgradeFormatScore?: number;
  language?: string;
  score_set?: string;
  items?: Array<{
    name: string;
    allowed: boolean;
    items?: string[];
  }>;
  formatItems?: Record<string, string>;
  [k: string]: unknown;
}

// A full refresh calls ghAuthHeaders() (and so loadGithubToken()) once per file —
// potentially hundreds of times for a real TRaSH catalog. Memoize with a short
// TTL + in-flight coalescing (mirrors omdb.ts's getApiKey()) so a refresh issues
// one Setting read instead of hundreds; an admin's token change still propagates
// within the TTL window.
const GITHUB_TOKEN_TTL_MS = 30_000;
let githubTokenCache: { value: string | null; at: number } | null = null;
let githubTokenInflight: Promise<string | null> | null = null;

async function loadGithubToken(): Promise<string | null> {
  if (githubTokenCache && Date.now() - githubTokenCache.at < GITHUB_TOKEN_TTL_MS) {
    return githubTokenCache.value;
  }
  if (githubTokenInflight) return githubTokenInflight;
  const p = (async () => {
    const row = await prisma.setting.findUnique({ where: { key: "trashGithubToken" } });
    const value = row?.value && row.value.length > 0 ? row.value : null;
    githubTokenCache = { value, at: Date.now() };
    return value;
  })();
  githubTokenInflight = p;
  p.finally(() => { githubTokenInflight = null; }).catch(() => {});
  return p;
}

// Test-support only: the cache above is module-level state that would
// otherwise leak a stale (or absent) token across unrelated test() blocks in
// the same file/process. Not used by production code paths.
export function __resetGithubTokenCacheForTests(): void {
  githubTokenCache = null;
  githubTokenInflight = null;
}

async function ghAuthHeaders(): Promise<HeadersInit> {
  const token = await loadGithubToken();
  return {
    "User-Agent": USER_AGENT,
    Accept: "application/vnd.github+json",
    ...(token ? { Authorization: `token ${token}` } : {}),
  };
}

// Returns the tree entries plus a flag — callers persist truncation state via setRefreshTruncated()
async function ghTree(
  repo: string,
  branch: string,
): Promise<{ entries: GhTreeEntry[]; truncated: boolean }> {
  const url = `https://api.github.com/repos/${repo}/git/trees/${branch}?recursive=1`;
  const res = await safeFetchTrusted(url, {
    allowedHosts: ["api.github.com"],
    headers: await ghAuthHeaders(),
    timeoutMs: TREE_FETCH_TIMEOUT_MS,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => res.statusText);
    throw new Error(`GitHub tree fetch failed for ${repo}@${branch}: ${res.status} ${body.slice(0, 120)}`);
  }
  const data = (await res.json()) as { tree?: GhTreeEntry[]; truncated?: boolean };
  if (data.truncated) {
    // GitHub caps recursive tree responses; truncation here means some specs will be silently skipped this run
    console.warn(`[trash] tree truncated for ${repo}@${branch} — upstream has exceeded GitHub's tree cap`);
  }
  return { entries: data.tree ?? [], truncated: Boolean(data.truncated) };
}

// The one recursive TRaSH tree fetch, for callers that refresh BOTH services
// and want to hand the same listing to each `refreshCatalog` call (the nightly
// cron and the admin refresh route). Exposed as a thin wrapper so `ghTree`
// itself stays private to this module.
export type TrashTree = { entries: GhTreeEntry[]; truncated: boolean };
export async function fetchTrashTree(): Promise<TrashTree> {
  return ghTree(TRASH_REPO, TRASH_BRANCH);
}

async function setRefreshTruncated(truncated: boolean): Promise<void> {
  if (truncated) {
    const value = new Date().toISOString();
    await prisma.setting.upsert({
      where: { key: "trashLastRefreshTruncatedAt" },
      update: { value },
      create: { key: "trashLastRefreshTruncatedAt", value },
    });
  } else {
    // Best-effort clear; absence of the row means "never truncated" so a missing-row is fine
    await prisma.setting.deleteMany({ where: { key: "trashLastRefreshTruncatedAt" } });
  }
}

async function ghRawFile(repo: string, branch: string, path: string): Promise<string> {
  const url = `https://raw.githubusercontent.com/${repo}/${branch}/${path}`;
  const res = await safeFetchTrusted(url, {
    allowedHosts: ["raw.githubusercontent.com"],
    // Send the GitHub token here too (ghAuthHeaders), not only on the api.github.com
    // tree call — a full refresh pulls hundreds of files from raw.githubusercontent.com,
    // so the configured token should authenticate the high-volume path (private
    // repos + higher rate limits), not just the single tree request.
    headers: await ghAuthHeaders(),
    timeoutMs: RAW_FETCH_TIMEOUT_MS,
    maxResponseBytes: RAW_FETCH_MAX_BYTES,
  });
  if (!res.ok) {
    throw new Error(`raw fetch failed: ${path} ${res.status}`);
  }
  return res.text();
}

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

// Shared mutable counter so each kind's pass can record validator rejections without changing
// the existing { fetched, updated, unchanged } return shape consumers depend on.
interface ValidationCounter { count: number }

// Thrown inside a file fetch when the payload fails its type guard — counted
// as validationSkipped, unlike a network or JSON failure.
class PayloadShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayloadShapeError";
  }
}

// What a refreshed kind left behind: the counts, the trash_ids the upstream tree
// still carries, and whether that set is trustworthy enough to prune by.
interface KindPass {
  counts: { fetched: number; updated: number; unchanged: number };
  seen: Set<string>;
  complete: boolean;
}

interface RefreshContext {
  service: TrashService;
  tree: GhTreeEntry[];
  // `${kind}::${trashId}` → the stored row's upstream identity.
  storedByTrashId: Map<string, { sha: string | null; path: string }>;
  // `${kind}::${path}::${sha}` → the trash_id of the stored row whose content
  // is exactly that blob. A tree entry found here needs no download.
  storedByBlob: Map<string, string>;
  now: Date;
  errors: string[];
  validationCounter: ValidationCounter;
  signal?: AbortSignal;
}

// Stored on an application whose spec the upstream catalog no longer carries.
const REMOVED_UPSTREAM_ERROR =
  "Removed from the TRaSH Guides catalog upstream, so it is no longer applied. Delete this application to drop the spec.";

// Pulls the TRaSH-Guides tree from GitHub and upserts every spec kind (CFs, CF-groups, naming, profiles, sizes) for one service into TrashSpec.
// `prefetchedTree` lets a caller refreshing BOTH services share one ~573 KB
// recursive tree fetch instead of pulling the identical tree back-to-back.
// `signal` (the advisory lock's, guardrail 41) is checked at every download
// batch: an aborted pass returns what it did, marked `aborted`, and prunes nothing.
export async function refreshCatalog(
  service: TrashService,
  prefetchedTree?: { entries: GhTreeEntry[]; truncated: boolean },
  opts: { signal?: AbortSignal } = {},
): Promise<RefreshResult> {
  const errors: string[] = [];
  const validationCounter: ValidationCounter = { count: 0 };
  const now = new Date();

  const { entries: trashTree, truncated } = prefetchedTree ?? await ghTree(TRASH_REPO, TRASH_BRANCH);
  // Persist truncation state so the admin UI / diagnostic can surface it. Failure to persist must
  // not block the refresh itself — the warn log is still emitted in ghTree.
  await setRefreshTruncated(truncated).catch((err) => {
    console.warn("[trash] failed to persist truncation state:", err instanceof Error ? err.message : err);
  });

  const existing = await prisma.trashSpec.findMany({
    where: { service },
    select: { id: true, kind: true, trashId: true, upstreamSha: true, upstreamPath: true },
  });
  const storedByTrashId = new Map<string, { sha: string | null; path: string }>();
  const storedByBlob = new Map<string, string>();
  for (const s of existing) {
    storedByTrashId.set(`${s.kind}::${s.trashId}`, { sha: s.upstreamSha, path: s.upstreamPath });
    if (s.upstreamSha) storedByBlob.set(`${s.kind}::${s.upstreamPath}::${s.upstreamSha}`, s.trashId);
  }
  const ctx: RefreshContext = {
    service,
    tree: trashTree,
    storedByTrashId,
    storedByBlob,
    now,
    errors,
    validationCounter,
    signal: opts.signal,
  };
  const paths = TRASH_PATHS[service];

  const cf = await refreshDir(ctx, {
    kind: "CUSTOM_FORMAT",
    dir: paths.cf,
    label: "cf",
    validate: isCustomFormatPayload,
    toRow: (p) => ({ trashId: p.trash_id, name: p.name }),
  });
  // CF-Groups must refresh AFTER CFs so member trash_ids resolve against fresh spec rows
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
    toRow: (p, file) => ({ trashId: p.trash_id, name: p.type ?? fileSlug(file.path) }),
  });

  const aborted = opts.signal?.aborted === true;
  // Prune only from a listing that is whole (not truncated) and a pass that read
  // all of it: a kind with any fetch/parse/validation error, or no files listed
  // at all (a moved upstream directory reads as empty), keeps every row.
  let removedUpstream: { deleted: number; disabled: number } | null = null;
  if (!aborted && !truncated) {
    const passes = new Map<TrashSpecKind, KindPass>([
      ["CUSTOM_FORMAT", cf],
      ["CUSTOM_FORMAT_GROUP", cfg],
      ["QUALITY_PROFILE", qp],
      ["QUALITY_SIZE", qs],
    ]);
    const unseen = existing
      .filter((s) => {
        const pass = passes.get(s.kind);
        return pass !== undefined && pass.complete && !pass.seen.has(s.trashId);
      })
      .map((s) => s.id);
    const pruned = await pruneRemovedSpecs(unseen, now);
    if (pruned.deleted > 0 || pruned.disabled > 0) removedUpstream = pruned;
  }

  return {
    service,
    customFormats: cf.counts,
    customFormatGroups: cfg.counts,
    naming,
    qualityProfiles: { fetched: qp.counts.fetched, updated: qp.counts.updated },
    qualitySizes: { fetched: qs.counts.fetched, updated: qs.counts.updated },
    errors,
    ...(validationCounter.count > 0 ? { validationSkipped: validationCounter.count } : {}),
    ...(removedUpstream ? { removedUpstream } : {}),
    ...(aborted ? { aborted: true as const } : {}),
  };
}

function fileSlug(path: string): string {
  return path.split("/").pop()!.replace(/\.json$/, "");
}

interface DirDef<T> {
  kind: TrashSpecKind;
  dir: string;
  // Prefix of this kind's lines in RefreshResult.errors.
  label: string;
  validate: (v: unknown) => v is T;
  toRow: (parsed: T, file: GhTreeEntry) => { trashId: string; name: string; description?: string | null };
}

// One spec kind's directory: skip every file whose blob is already stored,
// download the rest GH_CONCURRENCY at a time, validate, and upsert each batch's
// changed rows in one transaction (sequential awaits, BATCH_TX_TIMEOUT —
// guardrails 4/23c). A validator reject or failed download writes nothing for
// that file, so its old sha stays and the next refresh retries it.
async function refreshDir<T>(ctx: RefreshContext, def: DirDef<T>): Promise<KindPass> {
  const files = ctx.tree.filter(
    (t) => t.type === "blob" && t.path.startsWith(`${def.dir}/`) && t.path.endsWith(".json"),
  );
  const counts = { fetched: 0, updated: 0, unchanged: 0 };
  const seen = new Set<string>();
  let complete = files.length > 0;

  const toFetch: GhTreeEntry[] = [];
  for (const f of files) {
    const storedTrashId = ctx.storedByBlob.get(`${def.kind}::${f.path}::${f.sha}`);
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
    const batch = toFetch.slice(i, i + GH_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (f) => {
        const content = await ghRawFile(TRASH_REPO, TRASH_BRANCH, f.path);
        const parsedRaw = JSON.parse(content) as unknown;
        // Validate shape against the apply-path's contract — malformed payloads are skipped so the
        // prior good upstreamSha is preserved for the next refresh attempt.
        if (!def.validate(parsedRaw)) {
          throw new PayloadShapeError(`${def.label} payload shape mismatch: ${f.path}`);
        }
        return { row: def.toRow(parsedRaw, f), payload: parsedRaw, file: f };
      }),
    );

    const toUpsert: Array<{
      trashId: string;
      name: string;
      description?: string | null;
      payload: T;
      path: string;
      sha: string;
    }> = [];
    for (const r of results) {
      if (r.status !== "fulfilled") {
        complete = false;
        if (r.reason instanceof PayloadShapeError) ctx.validationCounter.count++;
        const message = r.reason instanceof Error ? r.reason.message : String(r.reason);
        ctx.errors.push(`${def.label}: ${message}`);
        continue;
      }
      counts.fetched++;
      const { row, payload, file } = r.value;
      seen.add(row.trashId);
      // The same content may sit at a new path (a moved file): rewrite the row so
      // its stored path matches and the next refresh can skip the download.
      const stored = ctx.storedByTrashId.get(`${def.kind}::${row.trashId}`);
      if (stored && stored.sha === file.sha && stored.path === file.path) {
        counts.unchanged++;
        continue;
      }
      toUpsert.push({ ...row, payload, path: file.path, sha: file.sha });
    }

    if (toUpsert.length > 0) {
      await prisma.$transaction(async (tx) => {
        for (const row of toUpsert) {
          const fields = {
            name: row.name,
            ...(row.description !== undefined ? { description: row.description } : {}),
            payload: row.payload as unknown as object,
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
      counts.updated += toUpsert.length;
    }
  }

  return { counts, seen, complete };
}

async function refreshNaming(ctx: RefreshContext): Promise<{ fetched: number; updated: number }> {
  const path = TRASH_PATHS[ctx.service].naming;
  const file = ctx.tree.find((t) => t.type === "blob" && t.path === path);
  if (!file) {
    ctx.errors.push(`naming: upstream file missing (${path})`);
    return { fetched: 0, updated: 0 };
  }
  const trashId = "default";
  if (ctx.storedByBlob.get(`NAMING::${file.path}::${file.sha}`) === trashId) {
    return { fetched: 1, updated: 0 };
  }
  if (ctx.signal?.aborted) return { fetched: 0, updated: 0 };

  let raw: string;
  try {
    raw = await ghRawFile(TRASH_REPO, TRASH_BRANCH, file.path);
  } catch (err) {
    ctx.errors.push(`naming: ${err instanceof Error ? err.message : String(err)}`);
    return { fetched: 0, updated: 0 };
  }
  let parsed: Record<string, unknown>;
  try {
    const parsedRaw = JSON.parse(raw) as unknown;
    if (!isNamingPayload(parsedRaw)) {
      ctx.validationCounter.count++;
      ctx.errors.push(`naming: payload shape mismatch (${file.path})`);
      return { fetched: 1, updated: 0 };
    }
    parsed = parsedRaw;
  } catch (err) {
    ctx.errors.push(`naming: parse failed ${err instanceof Error ? err.message : String(err)}`);
    return { fetched: 0, updated: 0 };
  }

  const stored = ctx.storedByTrashId.get(`NAMING::${trashId}`);
  if (stored && stored.sha === file.sha && stored.path === file.path) {
    return { fetched: 1, updated: 0 };
  }
  const fields = {
    name: "TRaSH Standard Naming",
    payload: parsed as object,
    upstreamPath: file.path,
    upstreamSha: file.sha,
    fetchedAt: ctx.now,
  };
  await prisma.trashSpec.upsert({
    where: { service_kind_trashId: { service: ctx.service, kind: "NAMING", trashId } },
    update: fields,
    create: { service: ctx.service, kind: "NAMING", trashId, ...fields },
  });
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

export interface ApplyResult {
  specId: string;
  kind: TrashSpecKind;
  trashId: string;
  name: string;
  ok: boolean;
  remoteId?: number;
  error?: string;
  // True when the apply landed via a POST after a PUT-404 (Arr resource was deleted out-of-band).
  // Surfaced to the UI and audit log so admins can tell drift recovery from normal applies.
  recreated?: boolean;
  // QUALITY_SIZE only: every quality this spec sets was set again by a later
  // spec in the same merge (see applyQualitySizes), so none of its values were
  // sent. The names are those later specs'.
  supersededBy?: string[];
}

function formatArrError(err: unknown): string {
  if (err instanceof ArrResponseError) {
    const body = err.body.slice(0, 2000);
    try {
      const parsed = JSON.parse(body) as unknown;
      if (Array.isArray(parsed)) {
        const messages = (parsed as Array<{ propertyName?: string; errorMessage?: string; message?: string }>)
          .map((v) => {
            const prop = v.propertyName ? `${v.propertyName}: ` : "";
            return `${prop}${v.errorMessage ?? v.message ?? JSON.stringify(v)}`;
          });
        if (messages.length > 0) return `${err.status} — ${messages.join("; ")}`;
      }
      if (parsed && typeof parsed === "object") {
        const obj = parsed as Record<string, unknown>;
        const msg = obj.message ?? obj.error ?? JSON.stringify(obj);
        return `${err.status} — ${String(msg).slice(0, 500)}`;
      }
    } catch {
      // Body isn't JSON — fall through and show the raw text instead.
    }
    return `${err.status} — ${body.replace(/\s+/g, " ").slice(0, 500)}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

// Coerces each spec's `fields` into the array shape Arr expects (TRaSH payloads sometimes key them as an object).
function normalizeSpecFields(specifications: unknown[]): unknown[] {
  return specifications.map((s) => {
    if (!s || typeof s !== "object") return s;
    const spec = s as Record<string, unknown>;
    const fields = spec.fields;
    if (Array.isArray(fields)) return spec;
    if (fields && typeof fields === "object") {
      const arr = Object.entries(fields as Record<string, unknown>).map(([name, value]) => ({ name, value }));
      return { ...spec, fields: arr };
    }
    return { ...spec, fields: [] };
  });
}

// The instance an apply names has no URL/API key. applySpecs records nothing
// for it: there is no instance to have failed against.
class ArrNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArrNotConfiguredError";
  }
}

async function resolveCfg(service: TrashService, variant: ArrVariant = "hd"): Promise<ArrCfg> {
  const key = service === "RADARR" ? "radarr" : "sonarr";
  const cfg = await getArrCfg(key, variant);
  if (!cfg) {
    const instance = variant === "hd" ? "" : variant;
    throw new ArrNotConfiguredError(`${service}${instance ? ` (${instance})` : ""} is not configured`);
  }
  return cfg;
}

// Update an Arr resource by remoteId (PUT), recovering with a POST if Radarr/Sonarr returns 404.
// Returns the resource and a flag so callers can audit the recreate. Does NOT clear the old remoteId
// before the POST succeeds — losing the mapping mid-call would accumulate duplicate resources.
async function arrPutOrRecreate<T extends { id: number }>(
  cfg: ArrCfg,
  putPath: string,
  postPath: string,
  putBody: object,
  postBody: object,
): Promise<{ resource: T; recreated: boolean }> {
  try {
    const resource = await arrFetch<T>(cfg, putPath, {
      method: "PUT",
      body: JSON.stringify(putBody),
    });
    return { resource, recreated: false };
  } catch (err) {
    if (err instanceof ArrResponseError && err.status === 404) {
      // Resource was deleted in the Arr UI between Summonarr's last apply and now. Recreate it.
      // The recreate POST is intentionally not wrapped in retry logic — a second 404 is a real failure.
      const resource = await arrFetch<T>(cfg, postPath, {
        method: "POST",
        body: JSON.stringify(postBody),
      });
      return { resource, recreated: true };
    }
    throw err;
  }
}

function isPrismaNotFound(err: unknown): boolean {
  return isPrismaErrorCode(err, "P2025");
}

function isPrismaUniqueViolation(err: unknown): boolean {
  return isPrismaErrorCode(err, "P2002");
}

async function recordApply(
  spec: { id: string; kind: TrashSpecKind; trashId: string; name: string },
  outcome:
    | { ok: true; remoteId?: number; recreated?: boolean }
    | { ok: false; error: string },
  arrInstance: string,
): Promise<ApplyResult> {
  // Race-safety: when two `applySpecs` runs interleave on the same spec (admin Apply during a cron
  // run after lock contention is resolved), a read-modify-write on errorCount loses one of the
  // increments. The failure path uses update-with-increment + P2025 fallback for that reason.
  // The success path doesn't increment, so a single `upsert` is atomic and avoids the noisy
  // "No record was found for an update" Prisma error log that the previous update→create dance
  // produced on first apply.
  if (outcome.ok) {
    const appliedAt = new Date();
    // `enabled` is deliberately NOT in the shared payload. It belongs on CREATE — a
    // brand-new application starts enabled — but writing it on UPDATE silently reverts
    // an admin's explicit disable: the cron only applies `enabled: true` rows, but a
    // manual apply (/api/admin/trash-guides/apply names specIds directly) and the
    // dependency cascade both reach a disabled row, and a successful outcome then
    // turned the toggle back on with nothing in the UI to explain it.
    const successUpdate = {
      appliedAt,
      lastError: null,
      lastErrorAt: null,
      errorCount: 0,
      ...(outcome.remoteId != null ? { remoteId: outcome.remoteId } : {}),
    };
    await prisma.trashApplication.upsert({
      where: { trashSpecId_arrInstance: { trashSpecId: spec.id, arrInstance } },
      update: successUpdate,
      create: { trashSpecId: spec.id, arrInstance, enabled: true, ...successUpdate },
    });
  } else {
    const lastErrorAt = new Date();
    const failureUpdate = {
      lastError: outcome.error,
      lastErrorAt,
      errorCount: { increment: 1 },
    };
    try {
      await prisma.trashApplication.update({
        where: { trashSpecId_arrInstance: { trashSpecId: spec.id, arrInstance } },
        data: failureUpdate,
      });
    } catch (err) {
      if (!isPrismaNotFound(err)) throw err;
      try {
        await prisma.trashApplication.create({
          data: {
            trashSpecId: spec.id,
            arrInstance,
            lastError: outcome.error,
            lastErrorAt,
            errorCount: 1,
          },
        });
      } catch (createErr) {
        if (!isPrismaUniqueViolation(createErr)) throw createErr;
        // Concurrent create from another path won the race — increment our count via update instead
        // so the failure tally still reflects this attempt.
        await prisma.trashApplication.update({
          where: { trashSpecId_arrInstance: { trashSpecId: spec.id, arrInstance } },
          data: failureUpdate,
        });
      }
    }
  }
  return {
    specId: spec.id,
    kind: spec.kind,
    trashId: spec.trashId,
    name: spec.name,
    ok: outcome.ok,
    ...(outcome.ok && outcome.remoteId != null ? { remoteId: outcome.remoteId } : {}),
    ...(outcome.ok && outcome.recreated ? { recreated: true } : {}),
    ...(!outcome.ok ? { error: outcome.error } : {}),
  };
}

// Pushes the given CUSTOM_FORMAT specs to the Radarr/Sonarr instance for `variant` (PUT existing / POST new), recording each outcome.
export async function applyCustomFormats(
  service: TrashService,
  specIds: string[],
  variant: ArrVariant = "hd",
): Promise<ApplyResult[]> {
  const arrInstance = variant === "hd" ? "" : variant;
  const cfg = await resolveCfg(service, variant);
  const specs = await prisma.trashSpec.findMany({
    where: { id: { in: specIds }, service, kind: "CUSTOM_FORMAT" },
    include: { applications: { where: { arrInstance } } },
  });
  if (specs.length === 0) return [];

  // Projection for the no-op compare: exactly the fields the PUT body writes,
  // applied to BOTH sides so extra metadata on either side (remote
  // implementationName/infoLink/field labels, TRaSH trash_scores) can't defeat
  // equality. STRICT on absence — a remote row that omits a field the body
  // sets stays unequal and still PUTs (drift repair is the feature).
  type CfSpecLike = { name?: unknown; implementation?: unknown; negate?: unknown; required?: unknown; fields?: unknown };
  const projectCfForCompare = (cf: { name?: unknown; includeCustomFormatWhenRenaming?: unknown; specifications?: unknown }): string => {
    const specifications = Array.isArray(cf.specifications) ? (cf.specifications as CfSpecLike[]) : [];
    return JSON.stringify({
      name: cf.name,
      includeCustomFormatWhenRenaming: cf.includeCustomFormatWhenRenaming ?? false,
      specifications: specifications.map((s) => ({
        name: s.name,
        implementation: s.implementation,
        negate: s.negate,
        required: s.required,
        fields: Array.isArray(s.fields)
          ? (s.fields as Array<{ name?: unknown; value?: unknown }>).map((f) => ({ name: f.name, value: f.value }))
          : [],
      })),
    });
  };

  type RemoteCf = { id: number; name: string; includeCustomFormatWhenRenaming?: boolean; specifications?: unknown[] };
  let remoteByName: Map<string, number>;
  let remoteById: Map<number, RemoteCf>;
  let remoteNameById: Map<number, string>;
  try {
    const remote = await arrFetch<RemoteCf[]>(cfg, "/api/v3/customformat");
    remoteByName = new Map(remote.map((r) => [r.name, r.id]));
    remoteById = new Map(remote.map((r) => [r.id, r]));
    remoteNameById = new Map(remote.map((r) => [r.id, r.name]));
  } catch (err) {
    // Can't read existing CFs → can't tell new from existing, so a blind POST in
    // the loop below would create duplicates. Fail the whole batch instead of
    // guessing, and log a warning so the failure is visible.
    console.warn("[trash] failed to prefetch remote customformat list:", err instanceof Error ? err.message : err);
    return mapLimit(specs, RECORD_APPLY_CONCURRENCY, (spec) =>
      recordApply(spec, { ok: false, error: "Could not read existing custom formats from the *arr instance" }, arrInstance),
    );
  }

  const results: ApplyResult[] = [];
  for (const spec of specs) {
    const payload = spec.payload as unknown as TrashCustomFormat;
    const body = {
      name: payload.name,
      includeCustomFormatWhenRenaming: payload.includeCustomFormatWhenRenaming ?? false,
      specifications: normalizeSpecFields(payload.specifications ?? []),
    };
    try {

      // PUT if remoteId is known (update existing); POST only for truly new CFs to avoid duplicate creation.
      // arrPutOrRecreate transparently recovers if the resource was deleted in the Arr UI between
      // Summonarr's last apply and now (PUT → 404 → POST).
      const remoteId = resolveRemoteId(spec.applications[0]?.remoteId, payload.name, remoteNameById, remoteByName);
      // No-op skip: the cron re-applies every enabled spec each run to repair
      // drift (changes made by hand in Radarr/Sonarr). When the remote CF already
      // matches what we'd PUT, record success against the known id and skip the
      // write. Any difference (including remote rows missing fields) still PUTs.
      if (remoteId) {
        const remoteRow = remoteById.get(remoteId);
        // Only trust equality when the remote row actually CARRIES its
        // specifications array — a row without it (truncated response) is
        // unknown state, and treating absence as "empty" would wrongly skip
        // the PUT for a spec-less body.
        if (remoteRow && Array.isArray(remoteRow.specifications) && projectCfForCompare(remoteRow) === projectCfForCompare(body)) {
          results.push(await recordApply(spec, { ok: true, remoteId }, arrInstance));
          continue;
        }
      }
      let created: { id: number };
      let recreated = false;
      if (remoteId) {
        const out = await arrPutOrRecreate<{ id: number }>(
          cfg,
          `/api/v3/customformat/${remoteId}`,
          `/api/v3/customformat`,
          { id: remoteId, ...body },
          body,
        );
        created = out.resource;
        recreated = out.recreated;
      } else {
        created = await arrFetch<{ id: number }>(cfg, `/api/v3/customformat`, {
          method: "POST",
          body: JSON.stringify(body),
        });
      }
      results.push(await recordApply(spec, { ok: true, remoteId: created.id, recreated }, arrInstance));
    } catch (err) {
      results.push(await recordApply(spec, { ok: false, error: formatArrError(err) }, arrInstance));
    }
  }
  return results;
}

// Applies CF-Group specs by cascading their member CFs through applyCustomFormats, then rolls up per-group ok/fail on required members.
export async function applyCustomFormatGroups(
  service: TrashService,
  specIds: string[],
  variant: ArrVariant = "hd",
): Promise<ApplyResult[]> {
  const arrInstance = variant === "hd" ? "" : variant;
  const groups = await prisma.trashSpec.findMany({
    where: { id: { in: specIds }, service, kind: "CUSTOM_FORMAT_GROUP" },
  });
  if (groups.length === 0) return [];

  // Collect every referenced member trash_id, then resolve to local TrashSpec rows in one query
  const memberTrashIds = new Set<string>();
  const groupMembers = new Map<string, string[]>();
  for (const g of groups) {
    const payload = g.payload as unknown as TrashCustomFormatGroup;
    const ids = (payload.custom_formats ?? []).map((m) => m.trash_id).filter(Boolean);
    groupMembers.set(g.id, ids);
    for (const id of ids) memberTrashIds.add(id);
  }

  const memberSpecs = await prisma.trashSpec.findMany({
    where: { service, kind: "CUSTOM_FORMAT", trashId: { in: [...memberTrashIds] } },
    select: { id: true, trashId: true, name: true },
  });
  const cfSpecIdByTrashId = new Map(memberSpecs.map((s) => [s.trashId, s.id]));

  // Apply every member CF in one batch. The Set means a CF shared by several groups is applied once.
  const allCfSpecIds = [...new Set(memberSpecs.map((s) => s.id))];
  const cfResults = allCfSpecIds.length > 0 ? await applyCustomFormats(service, allCfSpecIds, variant) : [];
  const cfResultByTrashId = new Map(cfResults.map((r) => [r.trashId, r]));

  // Roll up per-group: a group "ok" means every required member resolved + applied successfully
  const results: ApplyResult[] = [];
  for (const g of groups) {
    const payload = g.payload as unknown as TrashCustomFormatGroup;
    const required = (payload.custom_formats ?? []).filter((m) => m.required);
    const memberIds = groupMembers.get(g.id) ?? [];

    const missing = memberIds.filter((id) => !cfSpecIdByTrashId.has(id));
    const failedRequired = required.filter((m) => {
      const r = cfResultByTrashId.get(m.trash_id);
      return !r || !r.ok;
    });

    if (missing.length === memberIds.length && memberIds.length > 0) {
      results.push(await recordApply(g, {
        ok: false,
        error: `No member custom formats found in catalog (${memberIds.length} expected). Refresh Catalog first.`,
      }, arrInstance));
      continue;
    }
    if (failedRequired.length > 0) {
      const names = failedRequired.slice(0, 3).map((m) => m.name).join(", ");
      const more = failedRequired.length > 3 ? ` (+${failedRequired.length - 3} more)` : "";
      results.push(await recordApply(g, {
        ok: false,
        error: `Required CF apply failed: ${names}${more}`,
      }, arrInstance));
      continue;
    }
    results.push(await recordApply(g, { ok: true }, arrInstance));
  }
  return results;
}

// Translates a TRaSH naming payload into the subset of Arr /config/naming fields to override (movie vs series/season/episode formats).
function buildNamingPatch(
  service: TrashService,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const pick = (group: unknown, key: string): string | undefined => {
    if (group && typeof group === "object" && key in (group as Record<string, unknown>)) {
      const v = (group as Record<string, unknown>)[key];
      return typeof v === "string" ? v : undefined;
    }
    return undefined;
  };

  if (service === "RADARR") {
    const file = payload.file;
    const folder = payload.folder;
    const patch: Record<string, unknown> = { renameMovies: true, replaceIllegalCharacters: true };
    const std = pick(file, "standard") ?? pick(file, "default");
    const folderStd = pick(folder, "default");
    if (std) patch.standardMovieFormat = std;
    if (folderStd) patch.movieFolderFormat = folderStd;
    return patch;
  }

  const series = payload.series;
  const season = payload.season;
  const episodes = payload.episodes;
  const patch: Record<string, unknown> = { renameEpisodes: true, replaceIllegalCharacters: true };
  // Sonarr's episodes.{standard,daily,anime} are objects keyed by variant ({ default, original, p2p-scene, ... }).
  // Older callers passed strings; tolerate both shapes by descending one level when we hit an object.
  const pickEpisodeFormat = (key: string): string | undefined => {
    const direct = pick(episodes, key);
    if (direct) return direct;
    if (episodes && typeof episodes === "object") {
      const nested = (episodes as Record<string, unknown>)[key];
      if (nested && typeof nested === "object") {
        return pick(nested, "default");
      }
    }
    return undefined;
  };
  const std = pickEpisodeFormat("standard");
  const daily = pickEpisodeFormat("daily");
  const anime = pickEpisodeFormat("anime");
  const seriesFolder = pick(series, "default");
  const seasonFolder = pick(season, "default");
  if (std) patch.standardEpisodeFormat = std;
  if (daily) patch.dailyEpisodeFormat = daily;
  if (anime) patch.animeEpisodeFormat = anime;
  if (seriesFolder) patch.seriesFolderFormat = seriesFolder;
  if (seasonFolder) patch.seasonFolderFormat = seasonFolder;
  return patch;
}

// Merges NAMING specs into the instance's full /config/naming (Arr requires all fields on PUT) and writes it back.
export async function applyNaming(
  service: TrashService,
  specIds: string[],
  variant: ArrVariant = "hd",
): Promise<ApplyResult[]> {
  const arrInstance = variant === "hd" ? "" : variant;
  const cfg = await resolveCfg(service, variant);
  const specs = await prisma.trashSpec.findMany({
    where: { id: { in: specIds }, service, kind: "NAMING" },
  });
  if (specs.length === 0) return [];

  try {

    // Fetch the full naming config first; Radarr/Sonarr require all fields on PUT, not just the changed ones
    const current = await arrFetch<Record<string, unknown>>(cfg, "/api/v3/config/naming");
    const merged: Record<string, unknown> = { ...current };
    for (const spec of specs) {
      const payload = spec.payload as unknown as Record<string, unknown>;
      const patch = buildNamingPatch(service, payload);
      Object.assign(merged, patch);
    }
    // No-op skip: `merged` spreads `current` first, so when every patch value
    // already matches the remote config the two serialize identically — record
    // success without the PUT (the cron re-applies every run for drift repair).
    if (JSON.stringify(merged) !== JSON.stringify(current)) {
      await arrFetch<unknown>(cfg, `/api/v3/config/naming`, {
        method: "PUT",
        body: JSON.stringify(merged),
      });
    }
    const results: ApplyResult[] = [];
    for (const spec of specs) results.push(await recordApply(spec, { ok: true }, arrInstance));
    return results;
  } catch (err) {
    const message = formatArrError(err);
    const results: ApplyResult[] = [];
    for (const spec of specs) results.push(await recordApply(spec, { ok: false, error: message }, arrInstance));
    return results;
  }
}

// Orders QUALITY_SIZE specs for the merge: by name, then trash_id, so the spec
// that wins a quality two of them set never depends on database row order.
function compareSizeSpecs(a: { name: string; trashId: string }, b: { name: string; trashId: string }): number {
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  if (a.trashId !== b.trashId) return a.trashId < b.trashId ? -1 : 1;
  return 0;
}

// Overrides the instance's quality-definition min/preferred/max sizes with the given QUALITY_SIZE specs (last writer wins per quality name, in compareSizeSpecs order).
export async function applyQualitySizes(
  service: TrashService,
  specIds: string[],
  variant: ArrVariant = "hd",
): Promise<ApplyResult[]> {
  const arrInstance = variant === "hd" ? "" : variant;
  const cfg = await resolveCfg(service, variant);
  const specs = (await prisma.trashSpec.findMany({
    where: { id: { in: specIds }, service, kind: "QUALITY_SIZE" },
  })).sort(compareSizeSpecs);
  if (specs.length === 0) return [];

  try {

    // Multiple specs may reference the same quality name; the last writer in
    // compareSizeSpecs order wins. `owner` remembers which spec that was.
    const combined = new Map<string, { min: number; preferred?: number; max: number }>();
    const owner = new Map<string, number>();
    specs.forEach((spec, i) => {
      const payload = spec.payload as unknown as TrashQualitySize;
      for (const q of payload.qualities ?? []) {
        combined.set(q.quality, { min: q.min, preferred: q.preferred, max: q.max });
        owner.set(q.quality, i);
      }
    });
    // A spec none of whose qualities it still owns contributed nothing.
    const supersededBy = (i: number): string[] | undefined => {
      const qualities = (specs[i].payload as unknown as TrashQualitySize).qualities ?? [];
      if (qualities.length === 0) return undefined;
      const winners = new Set<number>();
      for (const q of qualities) {
        const w = owner.get(q.quality);
        if (w === undefined || w === i) return undefined;
        winners.add(w);
      }
      return [...winners].sort((a, b) => a - b).map((w) => specs[w].name);
    };

    const remote = await arrFetch<Array<{ id: number; quality: { id: number; name: string }; title: string; weight: number; minSize?: number; maxSize?: number; preferredSize?: number }>>(
      cfg,
      "/api/v3/qualitydefinition",
    );
    const merged = remote.map((row) => {
      const over = combined.get(row.quality?.name);
      if (!over) return row;
      return {
        ...row,
        minSize: over.min,
        maxSize: over.max,
        ...(over.preferred !== undefined ? { preferredSize: over.preferred } : {}),
      };
    });

    // No-op skip: rows without an override are the SAME object reference, and
    // an overridden row that changed nothing serializes identically — skip the
    // PUT when no row actually differs (the cron re-applies every run).
    const changed = merged.some((row, i) => row !== remote[i] && JSON.stringify(row) !== JSON.stringify(remote[i]));
    if (changed) {
      await arrFetch<unknown>(cfg, "/api/v3/qualitydefinition/update", {
        method: "PUT",
        body: JSON.stringify(merged),
      });
    }

    const results: ApplyResult[] = [];
    for (let i = 0; i < specs.length; i++) {
      const result = await recordApply(specs[i], { ok: true }, arrInstance);
      const by = supersededBy(i);
      results.push(by ? { ...result, supersededBy: by } : result);
    }
    return results;
  } catch (err) {
    const message = formatArrError(err);
    const results: ApplyResult[] = [];
    for (const spec of specs) results.push(await recordApply(spec, { ok: false, error: message }, arrInstance));
    return results;
  }
}

interface RemoteQualityItem {
  id?: number;
  quality?: { id: number; name: string };
  name?: string;
  items?: RemoteQualityItem[];
  allowed: boolean;
}

interface RemoteFormatItem {
  format: number;
  name: string;
  score: number;
}

// Remote Radarr/Sonarr state that buildProfileBody needs, fetched once per
// batch by applyQualityProfiles and shared by every profile in it.
interface ProfileBuildRemotes {
  schema: Record<string, unknown>;
  remoteLanguages: Array<{ id: number; name: string }>;
  remoteCfs: Array<{ id: number; name: string; specifications?: Array<{ fields?: Array<{ name?: string; value?: unknown }> }> }>;
}

// Builds a profile's quality list from the TRaSH profile, keeping TRaSH's
// grouping and ranking rather than the schema's:
//   - TRaSH lists items best first; the Radarr/Sonarr API lists them worst
//     first (a higher index is a better quality), so TRaSH's order is reversed.
//   - A TRaSH group takes the id of the schema group with its name, else a
//     fresh id above every schema group id. Its members are pulled out of
//     wherever the schema put them. A group left with one known quality is sent
//     as that quality: the arr refuses a one-member group.
//   - Every schema quality appears exactly once. Those TRaSH doesn't name go
//     first (lowest), disallowed, in schema order; an untouched schema group
//     stays a group. A name the schema doesn't know is skipped.
// `idByName` maps each top-level item's name to its id, for the cutoff.
function buildProfileItems(
  schemaItems: RemoteQualityItem[],
  profileItems: NonNullable<TrashQualityProfile["items"]>,
): { items: RemoteQualityItem[]; idByName: Map<string, number> } {
  const leafByName = new Map<string, RemoteQualityItem>();
  const schemaGroupByName = new Map<string, RemoteQualityItem>();
  let maxGroupId = 999;
  for (const item of schemaItems) {
    if (item.items?.length) {
      if (item.name && !schemaGroupByName.has(item.name)) schemaGroupByName.set(item.name, item);
      if (typeof item.id === "number" && item.id > maxGroupId) maxGroupId = item.id;
      for (const sub of item.items) {
        if (sub.quality && !leafByName.has(sub.quality.name)) leafByName.set(sub.quality.name, sub);
      }
    } else if (item.quality && !leafByName.has(item.quality.name)) {
      leafByName.set(item.quality.name, item);
    }
  }

  const placed = new Set<string>();
  const usedGroupIds = new Set<number>();
  const idByName = new Map<string, number>();
  const nameId = (name: string, id: number) => {
    if (!idByName.has(name)) idByName.set(name, id);
  };
  let nextGroupId = maxGroupId + 1;
  const take = (name: string, allowed: boolean): RemoteQualityItem | null => {
    const leaf = leafByName.get(name);
    if (!leaf || placed.has(name)) return null;
    placed.add(name);
    return { ...leaf, allowed };
  };

  const ranked: RemoteQualityItem[] = [];
  for (const entry of profileItems) {
    // An entry without members that names a schema GROUP stands for that group.
    const schemaGroup = schemaGroupByName.get(entry.name);
    const memberNames = entry.items?.length
      ? entry.items
      : !leafByName.has(entry.name) && schemaGroup
        ? (schemaGroup.items ?? []).flatMap((sub) => (sub.quality ? [sub.quality.name] : []))
        : null;
    if (memberNames === null) {
      const leaf = take(entry.name, entry.allowed);
      if (leaf) {
        ranked.push(leaf);
        nameId(entry.name, leaf.quality!.id);
      }
      continue;
    }
    const members: RemoteQualityItem[] = [];
    for (const n of memberNames) {
      const leaf = take(n, entry.allowed);
      if (leaf) members.push(leaf);
    }
    if (members.length === 0) continue;
    if (members.length === 1) {
      ranked.push(members[0]);
      nameId(entry.name, members[0].quality!.id);
      nameId(members[0].quality!.name, members[0].quality!.id);
      continue;
    }
    const id = schemaGroup && typeof schemaGroup.id === "number" && !usedGroupIds.has(schemaGroup.id)
      ? schemaGroup.id
      : nextGroupId++;
    usedGroupIds.add(id);
    ranked.push({ ...(schemaGroup ?? {}), id, name: entry.name, allowed: entry.allowed, items: members });
    nameId(entry.name, id);
  }

  const rest: RemoteQualityItem[] = [];
  for (const item of schemaItems) {
    if (item.items?.length) {
      const subs = item.items.filter((sub) => sub.quality && !placed.has(sub.quality.name));
      const untouched = subs.length === item.items.length;
      if (untouched && typeof item.id === "number" && !usedGroupIds.has(item.id)) {
        for (const sub of subs) placed.add(sub.quality!.name);
        usedGroupIds.add(item.id);
        rest.push({ ...item, allowed: false, items: subs.map((sub) => ({ ...sub, allowed: false })) });
        if (item.name) nameId(item.name, item.id);
        continue;
      }
      for (const sub of subs) {
        if (placed.has(sub.quality!.name)) continue;
        placed.add(sub.quality!.name);
        rest.push({ ...sub, allowed: false });
        nameId(sub.quality!.name, sub.quality!.id);
      }
    } else if (item.quality && !placed.has(item.quality.name)) {
      placed.add(item.quality.name);
      rest.push({ ...item, allowed: false });
      nameId(item.quality.name, item.quality.id);
    }
  }

  return { items: [...rest, ...ranked.reverse()], idByName };
}

async function buildProfileBody(
  cfg: ArrCfg,
  service: TrashService,
  profile: TrashQualityProfile,
  variant: ArrVariant = "hd",
  shared?: ProfileBuildRemotes,
): Promise<Record<string, unknown>> {
  type RemoteCf = { id: number; name: string; specifications?: Array<{ fields?: Array<{ name?: string; value?: unknown }> }> };

  const [schema, remoteLanguages] = shared
    ? [shared.schema, shared.remoteLanguages]
    : await Promise.all([
        arrFetch<Record<string, unknown>>(cfg, "/api/v3/qualityprofile/schema"),
        arrFetch<Array<{ id: number; name: string }>>(cfg, "/api/v3/language").catch(() => [] as Array<{ id: number; name: string }>),
      ]);

  const schemaItems = (schema.items as RemoteQualityItem[] | undefined) ?? [];

  const referencedTrashIds = new Set<string>(Object.values(profile.formatItems ?? {}));
  // Resolve referenced CFs to remoteIds for THIS instance. Each Radarr/Sonarr instance assigns
  // its own customformat ids, so a profile must map against that instance's applications — mixing in
  // another instance's remoteIds would point the profile at the wrong (or non-existent) CFs.
  const arrInstance = variant === "hd" ? "" : variant;
  const applications = await prisma.trashApplication.findMany({
    where: {
      enabled: true,
      arrInstance,
      trashSpec: { service, kind: "CUSTOM_FORMAT", trashId: { in: [...referencedTrashIds] } },
    },
    include: { trashSpec: true },
  });

  // The live CF list comes BEFORE any stored remoteId is trusted. An arr reset or
  // a CF deleted and recreated outside Summonarr leaves a stored id naming
  // nothing, or an unrelated CF: scoring by it would give the real CF 0 and the
  // unrelated one this CF's score. resolveRemoteId re-checks each id by name; an
  // id the live list doesn't carry counts as unapplied and joins the cascade.
  let remoteCfs: RemoteCf[] = shared ? shared.remoteCfs : await arrFetch<RemoteCf[]>(cfg, "/api/v3/customformat");
  const liveNameById = new Map(remoteCfs.map((r) => [r.id, r.name]));
  const liveIdByName = new Map(remoteCfs.map((r) => [r.name, r.id]));
  type SpecRow = (typeof applications)[number]["trashSpec"];
  const appliedByTrashId = new Map<string, number>();
  const staleSpecs: SpecRow[] = [];
  for (const a of applications) {
    if (a.remoteId == null) continue;
    const live = resolveRemoteId(a.remoteId, a.trashSpec.name, liveNameById, liveIdByName);
    if (live != null && liveNameById.has(live)) appliedByTrashId.set(a.trashSpec.trashId, live);
    else staleSpecs.push(a.trashSpec);
  }
  const staleTrashIds = new Set(staleSpecs.map((s) => s.trashId));
  const specsMissingApplication: SpecRow[] = [
    ...staleSpecs,
    ...(await prisma.trashSpec.findMany({
      where: {
        service,
        kind: "CUSTOM_FORMAT",
        trashId: { in: [...referencedTrashIds].filter((id) => !appliedByTrashId.has(id) && !staleTrashIds.has(id)) },
      },
    })),
  ];
  // Every referenced CF spec that exists is already in memory: a referenced
  // trashId either rode along on the application read above or was read just
  // now. Build the score lookup from that union — the dependency cascade below
  // writes TrashApplication rows and the *arr server, never TrashSpec.payload,
  // so these rows stay current — instead of re-reading the identical set
  // (payload JSON included) a third time per profile.
  const specByTrashId = new Map<string, SpecRow>();
  for (const a of applications) specByTrashId.set(a.trashSpec.trashId, a.trashSpec);
  for (const s of specsMissingApplication) specByTrashId.set(s.trashId, s);
  let cascadeApplied = false;
  if (specsMissingApplication.length > 0) {
    const depResults = await applyCustomFormats(
      service,
      specsMissingApplication.map((s) => s.id),
      variant,
    );
    for (const r of depResults) {
      if (r.ok && r.remoteId != null) {
        appliedByTrashId.set(r.trashId, r.remoteId);
        cascadeApplied = true;
      }
    }
  }

  // The CF list read above is valid only while the dependency cascade created
  // nothing — a cascade-created CF must land in formatItems, so refetch in that
  // case. Write the refetch back into the shared batch state too: the cascade
  // CREATED custom formats upstream and the DB now records them as applied, so
  // the NEXT profile in the batch computes cascadeApplied=false and takes the
  // shared list — which without the write-back is the pre-cascade snapshot
  // missing those very CFs. Their formatItems entries would be absent and
  // Radarr/Sonarr would read the scores as unset, silently dropping TRaSH's
  // (often large negative) scores for every profile after the first cascade.
  if (cascadeApplied) {
    remoteCfs = await arrFetch<RemoteCf[]>(cfg, "/api/v3/customformat");
    if (shared) shared.remoteCfs = remoteCfs;
  }

  // Some CFs in Arr embed a trash_id field in their spec metadata — use it to map remote CFs we didn't apply ourselves
  for (const cf of remoteCfs) {
    for (const spec of cf.specifications ?? []) {
      for (const field of spec.fields ?? []) {
        if (field.name === "trash_id" && typeof field.value === "string" && !appliedByTrashId.has(field.value)) {
          appliedByTrashId.set(field.value, cf.id);
        }
      }
    }
  }

  const { items, idByName } = buildProfileItems(schemaItems, profile.items ?? []);
  const cutoff = idByName.get(profile.cutoff ?? "");

  const scoreSet = profile.score_set ?? "default";
  const scoreByTrashId = new Map<string, number>();
  for (const trashId of referencedTrashIds) {
    const spec = specByTrashId.get(trashId);
    const trashScores = (spec?.payload as unknown as TrashCustomFormat | null)?.trash_scores;
    const score = trashScores?.[scoreSet] ?? trashScores?.default ?? 0;
    scoreByTrashId.set(trashId, score);
  }
  // One reverse index, built once the mapping is final, so each remote CF is a
  // single lookup however many the arr sends (guardrail 5i). The first trash_id
  // mapped to a remote id keeps it: stored applications, then the cascade, then
  // trash_id fields.
  const trashIdByRemoteId = new Map<number, string>();
  for (const [tid, rid] of appliedByTrashId) {
    if (!trashIdByRemoteId.has(rid)) trashIdByRemoteId.set(rid, tid);
  }
  const formatItems: RemoteFormatItem[] = remoteCfs.map((cf) => {
    const trashId = trashIdByRemoteId.get(cf.id);
    const score = trashId ? scoreByTrashId.get(trashId) ?? 0 : 0;
    return { format: cf.id, name: cf.name, score };
  });

  let language: { id: number; name: string } | undefined;
  const wantLang = (profile.language ?? "").toLowerCase();
  // Fallback ids (used only when GET /api/v3/language failed) must match
  // Radarr's Language.cs pseudo-languages: Any = -1, Original = -2. Radarr
  // stores and compares the id, not the name, so swapping them would silently
  // save the OPPOSITE setting ("Any" turns the language filter off entirely).
  if (wantLang === "original" || wantLang === "") {
    language = remoteLanguages.find((l) => l.name.toLowerCase() === "original") ?? { id: -2, name: "Original" };
  } else if (wantLang === "any") {
    language = remoteLanguages.find((l) => l.name.toLowerCase() === "any") ?? { id: -1, name: "Any" };
  } else {
    const match = remoteLanguages.find((l) => l.name.toLowerCase() === wantLang);
    if (match) language = match;
  }

  const body: Record<string, unknown> = { ...schema };
  body.name = profile.name;
  body.upgradeAllowed = profile.upgradeAllowed ?? true;
  body.minFormatScore = profile.minFormatScore ?? 0;
  body.cutoffFormatScore = profile.cutoffFormatScore ?? 0;
  if (profile.minUpgradeFormatScore != null) body.minUpgradeFormatScore = profile.minUpgradeFormatScore;
  body.items = items;
  body.formatItems = formatItems;
  if (cutoff != null) body.cutoff = cutoff;
  if (language) body.language = language;
  return body;
}

// Picks the remote id a CF / quality-profile apply should PUT to. A stored
// TrashApplication.remoteId is only trusted while the live row at that id still
// carries this spec's name: a reset/reinstalled Arr restarts ids at 1 and a
// CF deleted + re-imported outside Summonarr gets a new one, so a stale id can
// name an UNRELATED resource (the PUT would overwrite it) while the real one
// sits under a new id (a PUT 404 → POST then collides on the unique name).
//   - live row at the stored id has our name   → stored id
//   - some live row has our name               → that id
//   - live row at the stored id has another name → null (POST; never overwrite it)
//   - stored id absent from the live list      → stored id (PUT → 404 → POST recreate)
export function resolveRemoteId(
  storedId: number | null | undefined,
  name: string,
  remoteNameById: Map<number, string>,
  remoteByName: Map<string, number>,
): number | null {
  if (storedId && remoteNameById.get(storedId) === name) return storedId;
  const byName = remoteByName.get(name);
  if (byName) return byName;
  if (storedId && remoteNameById.has(storedId)) return null;
  return storedId || null;
}

// Builds each QUALITY_PROFILE body (resolving CF remoteIds + scores for the variant) and PUT/POSTs it to the instance.
export async function applyQualityProfiles(
  service: TrashService,
  specIds: string[],
  variant: ArrVariant = "hd",
): Promise<ApplyResult[]> {
  const arrInstance = variant === "hd" ? "" : variant;
  const cfg = await resolveCfg(service, variant);
  const specs = await prisma.trashSpec.findMany({
    where: { id: { in: specIds }, service, kind: "QUALITY_PROFILE" },
    include: { applications: { where: { arrInstance } } },
  });
  if (specs.length === 0) return [];

  let remoteByName: Map<string, number>;
  let remoteNameById: Map<number, string>;
  try {
    const remote = await arrFetch<Array<{ id: number; name: string }>>(cfg, "/api/v3/qualityprofile");
    remoteByName = new Map(remote.map((r) => [r.name, r.id]));
    remoteNameById = new Map(remote.map((r) => [r.id, r.name]));
  } catch (err) {
    // Can't read existing quality profiles → a blind POST below would duplicate
    // them. Fail the whole batch instead of guessing, and log a warning.
    console.warn("[trash] failed to prefetch remote qualityprofile list:", err instanceof Error ? err.message : err);
    return mapLimit(specs, RECORD_APPLY_CONCURRENCY, (spec) =>
      recordApply(spec, { ok: false, error: "Could not read existing quality profiles from the *arr instance" }, arrInstance),
    );
  }

  // Hoisted once per batch (AFTER the prefetch guard above, so the
  // prefetch-failure early return never pays these): schema, languages and the
  // CF list are instance-level state identical for every profile spec.
  // Best-effort — on failure each spec falls back to its own per-spec fetches,
  // whose errors are recorded individually as before.
  let sharedRemotes: ProfileBuildRemotes | undefined;
  try {
    const [schema, remoteLanguages, remoteCfs] = await Promise.all([
      arrFetch<Record<string, unknown>>(cfg, "/api/v3/qualityprofile/schema"),
      arrFetch<Array<{ id: number; name: string }>>(cfg, "/api/v3/language").catch(() => [] as Array<{ id: number; name: string }>),
      arrFetch<ProfileBuildRemotes["remoteCfs"]>(cfg, "/api/v3/customformat"),
    ]);
    sharedRemotes = { schema, remoteLanguages, remoteCfs };
  } catch {
    sharedRemotes = undefined;
  }

  const results: ApplyResult[] = [];
  for (const spec of specs) {
    try {
      const profile = spec.payload as unknown as TrashQualityProfile;
      const body = await buildProfileBody(cfg, service, profile, variant, sharedRemotes);
      const remoteId = resolveRemoteId(spec.applications[0]?.remoteId, profile.name, remoteNameById, remoteByName);
      let created: { id: number };
      let recreated = false;
      if (remoteId) {
        const out = await arrPutOrRecreate<{ id: number }>(
          cfg,
          `/api/v3/qualityprofile/${remoteId}`,
          `/api/v3/qualityprofile`,
          { id: remoteId, ...body },
          body,
        );
        created = out.resource;
        recreated = out.recreated;
      } else {
        created = await arrFetch<{ id: number }>(cfg, `/api/v3/qualityprofile`, {
          method: "POST",
          body: JSON.stringify(body),
        });
      }
      results.push(await recordApply(spec, { ok: true, remoteId: created.id, recreated }, arrInstance));
    } catch (err) {
      results.push(await recordApply(spec, { ok: false, error: formatArrError(err) }, arrInstance));
    }
  }
  return results;
}

// The results for one applySpecs kind group whose apply threw before it could
// record per-spec outcomes. An unconfigured instance is answered without a DB
// write (no stray TrashApplication rows for an instance that doesn't exist);
// any other failure is recorded against each spec, as a per-spec failure is.
async function failedGroupResults(
  specs: Array<{ id: string; kind: TrashSpecKind; trashId: string; name: string }>,
  err: unknown,
  arrInstance: string,
): Promise<ApplyResult[]> {
  const error = formatArrError(err);
  const notConfigured = err instanceof Error && err.name === "ArrNotConfiguredError";
  const results: ApplyResult[] = [];
  for (const spec of specs) {
    const unrecorded: ApplyResult = { specId: spec.id, kind: spec.kind, trashId: spec.trashId, name: spec.name, ok: false, error };
    if (notConfigured) {
      results.push(unrecorded);
      continue;
    }
    try {
      results.push(await recordApply(spec, { ok: false, error }, arrInstance));
    } catch (recordErr) {
      console.warn("[trash] could not record a failed apply:", recordErr instanceof Error ? recordErr.message : recordErr);
      results.push(unrecorded);
    }
  }
  return results;
}

// Applies a mixed set of specs by kind in dependency order (groups → CFs → profiles → naming → sizes), deduping CFs already cascaded by a group.
// Each (service, kind) group is contained: one that throws (its instance not
// configured, its arr unreachable mid-read) answers ok:false for its own specs
// and the rest still run, so the caller can return and audit what was written.
export async function applySpecs(specIds: string[], variant: ArrVariant = "hd"): Promise<ApplyResult[]> {
  const arrInstance = variant === "hd" ? "" : variant;
  const specs = await prisma.trashSpec.findMany({
    where: { id: { in: specIds } },
    select: { id: true, service: true, kind: true, trashId: true, name: true, payload: true },
  });
  const specById = new Map(specs.map((s) => [s.id, s]));

  // Dedupe: if a CF-Group is being applied alongside any of its member CFs, drop the redundant
  // standalone CFs — the group's apply cascade already applies them, and a second PUT would just
  // double the Radarr/Sonarr HTTP roundtrips.
  const cfGroupSpecs = specs.filter((s) => s.kind === "CUSTOM_FORMAT_GROUP");
  const memberTrashIdsByService = new Map<TrashService, Set<string>>();
  for (const g of cfGroupSpecs) {
    const payload = g.payload as unknown as TrashCustomFormatGroup;
    const set = memberTrashIdsByService.get(g.service) ?? new Set<string>();
    for (const m of payload.custom_formats ?? []) {
      if (m.trash_id) set.add(m.trash_id);
    }
    memberTrashIdsByService.set(g.service, set);
  }
  const cascadedCfSpecIds = new Set<string>();
  if (memberTrashIdsByService.size > 0) {
    const allMemberTrashIds = [...memberTrashIdsByService.values()].flatMap((s) => [...s]);
    const memberCfSpecs = await prisma.trashSpec.findMany({
      where: { kind: "CUSTOM_FORMAT", trashId: { in: allMemberTrashIds } },
      select: { id: true, service: true, trashId: true },
    });
    for (const m of memberCfSpecs) {
      if (memberTrashIdsByService.get(m.service)?.has(m.trashId)) {
        cascadedCfSpecIds.add(m.id);
      }
    }
  }

  const groups = new Map<string, string[]>();
  for (const s of specs) {
    if (s.kind === "CUSTOM_FORMAT" && cascadedCfSpecIds.has(s.id)) continue;
    const key = `${s.service}::${s.kind}`;
    const list = groups.get(key) ?? [];
    list.push(s.id);
    groups.set(key, list);
  }

  const all: ApplyResult[] = [];
  // CF-Groups must run before CUSTOM_FORMAT (groups cascade to members) and before QUALITY_PROFILE
  // (profiles depend on member CFs being present in Arr); naming and quality-sizes are independent.
  const orderedKinds: TrashSpecKind[] = [
    "CUSTOM_FORMAT_GROUP",
    "CUSTOM_FORMAT",
    "QUALITY_PROFILE",
    "NAMING",
    "QUALITY_SIZE",
  ];
  const orderedKeys = [...groups.keys()].sort((a, b) => {
    const ak = a.split("::")[1] as TrashSpecKind;
    const bk = b.split("::")[1] as TrashSpecKind;
    return orderedKinds.indexOf(ak) - orderedKinds.indexOf(bk);
  });
  for (const key of orderedKeys) {
    const ids = groups.get(key)!;
    const [service, kind] = key.split("::") as [TrashService, TrashSpecKind];
    let results: ApplyResult[] = [];
    try {
      if (kind === "CUSTOM_FORMAT") results = await applyCustomFormats(service, ids, variant);
      else if (kind === "CUSTOM_FORMAT_GROUP") results = await applyCustomFormatGroups(service, ids, variant);
      else if (kind === "NAMING") results = await applyNaming(service, ids, variant);
      else if (kind === "QUALITY_PROFILE") results = await applyQualityProfiles(service, ids, variant);
      else if (kind === "QUALITY_SIZE") results = await applyQualitySizes(service, ids, variant);
    } catch (err) {
      results = await failedGroupResults(ids.map((id) => specById.get(id)!), err, arrInstance);
    }
    for (const r of results) all.push(r);
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

// Cron entry point: refreshes the catalog from GitHub (gated to hourly) when enabled, then applies all enabled specs across every configured instance per service.
// `signal` is the advisory lock's AbortSignal (guardrail 41): the refresh stops
// at its next GitHub download batch, and the apply phase — an unbounded
// sequential arrFetch walk — at the next instance boundary, returning the
// partial result. Never keep working lock-free beside the retry the entrypoint
// schedules.
export async function runTrashSync(opts: { signal?: AbortSignal } = {}): Promise<TrashSyncResult> {
  const settings = await prisma.setting.findMany({
    where: {
      key: {
        in: [
          "trashGuidesEnabled",
          "trashSyncCustomFormats",
          "trashSyncCustomFormatGroups",
          "trashSyncQualityProfiles",
          "trashSyncNaming",
          "trashSyncQualitySizes",
          "trashLastRefreshAt",
        ],
      },
    },
  });
  const map = Object.fromEntries(settings.map((s) => [s.key, s.value]));

  const errors: string[] = [];
  if (map.trashGuidesEnabled !== "true") {
    return { refreshed: [], applied: [], errors: ["trashGuidesEnabled is off"] };
  }

  // Cadence gate: if a refresh ran within the last hour, skip the GitHub round-trip and run apply
  // alone. Lets users set TRASH_SYNC_INTERVAL more aggressively (e.g. every 15 minutes) for faster
  // apply-after-edit feedback without hammering GitHub.
  const lastRefreshAt = map.trashLastRefreshAt ? Date.parse(map.trashLastRefreshAt) : NaN;
  const shouldRefresh = Number.isNaN(lastRefreshAt) || Date.now() - lastRefreshAt > REFRESH_MIN_INTERVAL_MS;

  const services: TrashService[] = ["RADARR", "SONARR"];
  const refreshed: RefreshResult[] = [];
  if (shouldRefresh) {
    // ONE tree fetch shared by both services — the ~573 KB recursive listing is
    // identical for RADARR and SONARR, so fetching it per service doubled the
    // GitHub transfer every cycle. A tree-fetch failure fails both services'
    // refresh (errors pushed per service, refreshed stays empty), so the
    // last-refresh stamp below is skipped and the next tick retries.
    let sharedTree: { entries: GhTreeEntry[]; truncated: boolean } | null = null;
    try {
      sharedTree = await ghTree(TRASH_REPO, TRASH_BRANCH);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      for (const service of services) errors.push(`${service} refresh: ${msg}`);
    }
    if (sharedTree !== null) {
      for (const service of services) {
        if (opts.signal?.aborted) break;
        try {
          const r = await refreshCatalog(service, sharedTree, { signal: opts.signal });
          refreshed.push(r);
          errors.push(...r.errors.map((e) => `${service}: ${e}`));
        } catch (err) {
          errors.push(`${service} refresh: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    // Only stamp success if at least one service refreshed without throwing — partial-success here
    // is intentional, the gate is "we recently tried", not "the catalog is exhaustively current".
    // A refresh the lock's signal cut short is not a try: the next run starts it again.
    const aborted = opts.signal?.aborted === true || refreshed.some((r) => r.aborted);
    if (refreshed.length > 0 && !aborted) {
      const value = new Date().toISOString();
      await prisma.setting.upsert({
        where: { key: "trashLastRefreshAt" },
        update: { value },
        create: { key: "trashLastRefreshAt", value },
      }).catch((err) => {
        console.warn("[trash] failed to stamp last-refresh-at:", err instanceof Error ? err.message : err);
      });
    }
  }

  const enabledKinds: TrashSpecKind[] = [];
  if (map.trashSyncCustomFormats !== "false") enabledKinds.push("CUSTOM_FORMAT");
  if (map.trashSyncCustomFormatGroups !== "false") enabledKinds.push("CUSTOM_FORMAT_GROUP");
  if (map.trashSyncNaming !== "false") enabledKinds.push("NAMING");
  if (map.trashSyncQualityProfiles !== "false") enabledKinds.push("QUALITY_PROFILE");
  if (map.trashSyncQualitySizes !== "false") enabledKinds.push("QUALITY_SIZE");

  // Apply each configured instance independently. A named/4K instance does nothing unless an admin
  // has created applications for its slug (only possible once that instance is configured), so a
  // single-instance deployment only ever runs the default ("") pass. We loop per service so a
  // service's specs only target that service's instances.
  const applied: ApplyResult[] = [];
  for (const service of services) {
    if (opts.signal?.aborted) break;
    const arrService = service === "RADARR" ? "radarr" : "sonarr";
    const instances = await getSyncableArrInstances(arrService);
    for (const inst of instances) {
      // Return, never throw, on abort: withAdvisoryLock's race has already
      // settled on the timeout rejection and a throw here would be unhandled.
      if (opts.signal?.aborted) break;
      // Per-instance containment, mirroring the refresh loop above: one
      // instance's thrown apply (its arr down mid-batch, a DB blip) must not
      // abort every remaining instance's — and the other service's — applies.
      try {
        const applications = await prisma.trashApplication.findMany({
          where: {
            enabled: true,
            arrInstance: inst.slug,
            trashSpec: { service, kind: { in: enabledKinds } },
          },
          select: { trashSpecId: true },
        });
        if (applications.length === 0) continue;
        applied.push(...(await applySpecs(applications.map((a) => a.trashSpecId), inst.slug)));
      } catch (err) {
        errors.push(`${service}${inst.slug ? ` (${inst.slug})` : ""} apply: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  for (const r of applied) {
    if (!r.ok && r.error) errors.push(`apply ${r.trashId}: ${r.error}`);
  }

  return { refreshed, applied, errors };
}

export interface SpecStatus {
  id: string;
  service: TrashService;
  kind: TrashSpecKind;
  trashId: string;
  name: string;
  description: string | null;
  fetchedAt: string;
  application: {
    id: string;
    enabled: boolean;
    remoteId: number | null;
    appliedAt: string | null;
    lastError: string | null;
    lastErrorAt: string | null;
    errorCount: number;
  } | null;
}

// Lists all specs for a service with their per-variant application status, for the admin trash-guides UI.
export async function listSpecs(service: TrashService, variant: ArrVariant = "hd"): Promise<SpecStatus[]> {
  // Every column the status needs and no payload: the list covers the whole
  // catalog (hundreds of custom formats), and none of their JSON is returned.
  const rows = await prisma.trashSpec.findMany({
    where: { service },
    select: {
      id: true,
      service: true,
      kind: true,
      trashId: true,
      name: true,
      description: true,
      fetchedAt: true,
      applications: {
        where: { arrInstance: variant === "hd" ? "" : variant },
        select: {
          id: true,
          enabled: true,
          remoteId: true,
          appliedAt: true,
          lastError: true,
          lastErrorAt: true,
          errorCount: true,
        },
      },
    },
    orderBy: [{ kind: "asc" }, { name: "asc" }],
  });
  return rows.map((r) => {
    const app = r.applications[0] ?? null;
    return {
      id: r.id,
      service: r.service,
      kind: r.kind,
      trashId: r.trashId,
      name: r.name,
      description: r.description,
      fetchedAt: r.fetchedAt.toISOString(),
      application: app
        ? {
            id: app.id,
            enabled: app.enabled,
            remoteId: app.remoteId,
            appliedAt: app.appliedAt?.toISOString() ?? null,
            lastError: app.lastError,
            lastErrorAt: app.lastErrorAt?.toISOString() ?? null,
            errorCount: app.errorCount,
          }
        : null,
    };
  });
}

export interface SpecDetail extends SpecStatus {
  upstreamPath: string;
  upstreamSha: string | null;
  payload: unknown;
}

// Returns one spec including its full upstream payload + per-variant application status, for the spec detail view.
export async function getSpecDetail(id: string, variant: ArrVariant = "hd"): Promise<SpecDetail | null> {
  const row = await prisma.trashSpec.findUnique({
    where: { id },
    include: { applications: { where: { arrInstance: variant === "hd" ? "" : variant } } },
  });
  if (!row) return null;
  const app = row.applications[0] ?? null;
  return {
    id: row.id,
    service: row.service,
    kind: row.kind,
    trashId: row.trashId,
    name: row.name,
    description: row.description,
    fetchedAt: row.fetchedAt.toISOString(),
    upstreamPath: row.upstreamPath,
    upstreamSha: row.upstreamSha,
    payload: row.payload,
    application: app
      ? {
          id: app.id,
          enabled: app.enabled,
          remoteId: app.remoteId,
          appliedAt: app.appliedAt?.toISOString() ?? null,
          lastError: app.lastError,
          lastErrorAt: app.lastErrorAt?.toISOString() ?? null,
          errorCount: app.errorCount,
        }
      : null,
  };
}
