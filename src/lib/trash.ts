

import { prisma } from "./prisma";
import { safeFetchTrusted } from "./safe-fetch";
import { arrFetch, ArrResponseError, getArrCfg, type ArrCfg } from "./arr";
import { BATCH_TX_TIMEOUT } from "./cron-auth";
import {
  isCustomFormatPayload,
  isCustomFormatGroupPayload,
  isNamingPayload,
  isQualityProfilePayload,
  isQualitySizePayload,
} from "./trash-validators";
import type { TrashService, TrashSpecKind } from "@/generated/prisma";

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

async function loadGithubToken(): Promise<string | null> {
  const row = await prisma.setting.findUnique({ where: { key: "trashGithubToken" } });
  return row?.value && row.value.length > 0 ? row.value : null;
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
    headers: { "User-Agent": USER_AGENT },
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
}

// Shared mutable counter so each refreshXxx can record validator rejections without changing
// the existing { fetched, updated, unchanged } return shape consumers depend on.
interface ValidationCounter { count: number }

export async function refreshCatalog(service: TrashService): Promise<RefreshResult> {
  const errors: string[] = [];
  const validationCounter: ValidationCounter = { count: 0 };
  const now = new Date();

  const { entries: trashTree, truncated } = await ghTree(TRASH_REPO, TRASH_BRANCH);
  // Persist truncation state so the admin UI / diagnostic can surface it. Failure to persist must
  // not block the refresh itself — the warn log is still emitted in ghTree.
  await setRefreshTruncated(truncated).catch((err) => {
    console.warn("[trash] failed to persist truncation state:", err instanceof Error ? err.message : err);
  });

  const existing = await prisma.trashSpec.findMany({
    where: { service },
    select: { kind: true, trashId: true, upstreamSha: true },
  });
  const existingSha = new Map(
    existing.map((s) => [`${s.kind}::${s.trashId}`, s.upstreamSha]),
  );

  const cf = await refreshCustomFormats(service, trashTree, existingSha, now, errors, validationCounter);
  // CF-Groups must refresh AFTER CFs so member trash_ids resolve against fresh spec rows
  const cfg = await refreshCustomFormatGroups(service, trashTree, existingSha, now, errors, validationCounter);
  const naming = await refreshNaming(service, trashTree, existingSha, now, errors, validationCounter);
  const qp = await refreshQualityProfiles(service, trashTree, existingSha, now, errors, validationCounter);
  const qs = await refreshQualitySizes(service, trashTree, existingSha, now, errors, validationCounter);

  return {
    service,
    customFormats: cf,
    customFormatGroups: cfg,
    naming,
    qualityProfiles: qp,
    qualitySizes: qs,
    errors,
    ...(validationCounter.count > 0 ? { validationSkipped: validationCounter.count } : {}),
  };
}

async function refreshCustomFormats(
  service: TrashService,
  trashTree: GhTreeEntry[],
  existingSha: Map<string, string | null>,
  now: Date,
  errors: string[],
  validationCounter: ValidationCounter,
): Promise<{ fetched: number; updated: number; unchanged: number }> {
  const dir = TRASH_PATHS[service].cf;
  const files = trashTree.filter(
    (t) => t.type === "blob" && t.path.startsWith(`${dir}/`) && t.path.endsWith(".json"),
  );

  let fetched = 0;
  let updated = 0;
  let unchanged = 0;

  const toUpsert: Array<{
    trashId: string;
    name: string;
    payload: TrashCustomFormat;
    path: string;
    sha: string;
  }> = [];

  for (let i = 0; i < files.length; i += GH_CONCURRENCY) {
    const batch = files.slice(i, i + GH_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (f) => {
        const content = await ghRawFile(TRASH_REPO, TRASH_BRANCH, f.path);
        const parsedRaw = JSON.parse(content) as unknown;
        // Validate shape against the apply-path's contract — malformed payloads are skipped so the
        // prior good upstreamSha is preserved for the next refresh attempt.
        if (!isCustomFormatPayload(parsedRaw)) {
          throw new Error(`cf payload shape mismatch: ${f.path}`);
        }
        return { parsed: parsedRaw, file: f };
      }),
    );
    for (const r of results) {
      if (r.status !== "fulfilled") {
        const message = r.reason instanceof Error ? r.reason.message : String(r.reason);
        if (message.includes("payload shape mismatch")) validationCounter.count++;
        errors.push(`cf: ${message}`);
        continue;
      }
      fetched++;
      const { parsed, file } = r.value;
      const key = `CUSTOM_FORMAT::${parsed.trash_id}`;
      if (existingSha.get(key) === file.sha) {
        unchanged++;
        continue;
      }
      toUpsert.push({
        trashId: parsed.trash_id,
        name: parsed.name,
        payload: parsed,
        path: file.path,
        sha: file.sha,
      });
    }
  }

  if (toUpsert.length > 0) {
    await prisma.$transaction(async (tx) => {
      for (const row of toUpsert) {
        await tx.trashSpec.upsert({
          where: { service_kind_trashId: { service, kind: "CUSTOM_FORMAT", trashId: row.trashId } },
          update: {
            name: row.name,
            payload: row.payload as object,
            upstreamPath: row.path,
            upstreamSha: row.sha,
            fetchedAt: now,
          },
          create: {
            service,
            kind: "CUSTOM_FORMAT",
            trashId: row.trashId,
            name: row.name,
            payload: row.payload as object,
            upstreamPath: row.path,
            upstreamSha: row.sha,
            fetchedAt: now,
          },
        });
        updated++;
      }
    }, { timeout: BATCH_TX_TIMEOUT });
  }

  return { fetched, updated, unchanged };
}

async function refreshCustomFormatGroups(
  service: TrashService,
  trashTree: GhTreeEntry[],
  existingSha: Map<string, string | null>,
  now: Date,
  errors: string[],
  validationCounter: ValidationCounter,
): Promise<{ fetched: number; updated: number; unchanged: number }> {
  const dir = TRASH_PATHS[service].cfGroups;
  const files = trashTree.filter(
    (t) => t.type === "blob" && t.path.startsWith(`${dir}/`) && t.path.endsWith(".json"),
  );

  let fetched = 0;
  let updated = 0;
  let unchanged = 0;

  const toUpsert: Array<{
    trashId: string;
    name: string;
    description: string | null;
    payload: TrashCustomFormatGroup;
    path: string;
    sha: string;
  }> = [];

  for (let i = 0; i < files.length; i += GH_CONCURRENCY) {
    const batch = files.slice(i, i + GH_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (f) => {
        const content = await ghRawFile(TRASH_REPO, TRASH_BRANCH, f.path);
        const parsedRaw = JSON.parse(content) as unknown;
        if (!isCustomFormatGroupPayload(parsedRaw)) {
          throw new Error(`cf-group payload shape mismatch: ${f.path}`);
        }
        return { parsed: parsedRaw, file: f };
      }),
    );
    for (const r of results) {
      if (r.status !== "fulfilled") {
        const message = r.reason instanceof Error ? r.reason.message : String(r.reason);
        if (message.includes("payload shape mismatch")) validationCounter.count++;
        errors.push(`cf-group: ${message}`);
        continue;
      }
      fetched++;
      const { parsed, file } = r.value;
      const key = `CUSTOM_FORMAT_GROUP::${parsed.trash_id}`;
      if (existingSha.get(key) === file.sha) {
        unchanged++;
        continue;
      }
      toUpsert.push({
        trashId: parsed.trash_id,
        name: parsed.name,
        description: parsed.trash_description ?? null,
        payload: parsed,
        path: file.path,
        sha: file.sha,
      });
    }
  }

  if (toUpsert.length > 0) {
    await prisma.$transaction(async (tx) => {
      for (const row of toUpsert) {
        await tx.trashSpec.upsert({
          where: { service_kind_trashId: { service, kind: "CUSTOM_FORMAT_GROUP", trashId: row.trashId } },
          update: {
            name: row.name,
            description: row.description,
            payload: row.payload as object,
            upstreamPath: row.path,
            upstreamSha: row.sha,
            fetchedAt: now,
          },
          create: {
            service,
            kind: "CUSTOM_FORMAT_GROUP",
            trashId: row.trashId,
            name: row.name,
            description: row.description,
            payload: row.payload as object,
            upstreamPath: row.path,
            upstreamSha: row.sha,
            fetchedAt: now,
          },
        });
        updated++;
      }
    }, { timeout: BATCH_TX_TIMEOUT });
  }

  return { fetched, updated, unchanged };
}

async function refreshNaming(
  service: TrashService,
  trashTree: GhTreeEntry[],
  existingSha: Map<string, string | null>,
  now: Date,
  errors: string[],
  validationCounter: ValidationCounter,
): Promise<{ fetched: number; updated: number }> {
  const path = TRASH_PATHS[service].naming;
  const file = trashTree.find((t) => t.type === "blob" && t.path === path);
  if (!file) {
    errors.push(`naming: upstream file missing (${path})`);
    return { fetched: 0, updated: 0 };
  }

  let raw: string;
  try {
    raw = await ghRawFile(TRASH_REPO, TRASH_BRANCH, file.path);
  } catch (err) {
    errors.push(`naming: ${err instanceof Error ? err.message : String(err)}`);
    return { fetched: 0, updated: 0 };
  }
  let parsed: Record<string, unknown>;
  try {
    const parsedRaw = JSON.parse(raw) as unknown;
    if (!isNamingPayload(parsedRaw)) {
      validationCounter.count++;
      errors.push(`naming: payload shape mismatch (${file.path})`);
      return { fetched: 1, updated: 0 };
    }
    parsed = parsedRaw;
  } catch (err) {
    errors.push(`naming: parse failed ${err instanceof Error ? err.message : String(err)}`);
    return { fetched: 0, updated: 0 };
  }

  const trashId = "default";
  if (existingSha.get(`NAMING::${trashId}`) === file.sha) {
    return { fetched: 1, updated: 0 };
  }
  await prisma.trashSpec.upsert({
    where: { service_kind_trashId: { service, kind: "NAMING", trashId } },
    update: {
      name: "TRaSH Standard Naming",
      payload: parsed as object,
      upstreamPath: file.path,
      upstreamSha: file.sha,
      fetchedAt: now,
    },
    create: {
      service,
      kind: "NAMING",
      trashId,
      name: "TRaSH Standard Naming",
      payload: parsed as object,
      upstreamPath: file.path,
      upstreamSha: file.sha,
      fetchedAt: now,
    },
  });
  return { fetched: 1, updated: 1 };
}

async function refreshQualityProfiles(
  service: TrashService,
  trashTree: GhTreeEntry[],
  existingSha: Map<string, string | null>,
  now: Date,
  errors: string[],
  validationCounter: ValidationCounter,
): Promise<{ fetched: number; updated: number }> {
  const dir = TRASH_PATHS[service].qualityProfiles;
  const files = trashTree.filter(
    (t) => t.type === "blob" && t.path.startsWith(`${dir}/`) && t.path.endsWith(".json"),
  );

  let fetched = 0;
  let updated = 0;

  for (let i = 0; i < files.length; i += GH_CONCURRENCY) {
    const batch = files.slice(i, i + GH_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (f) => {
        const content = await ghRawFile(TRASH_REPO, TRASH_BRANCH, f.path);
        const parsedRaw = JSON.parse(content) as unknown;
        if (!isQualityProfilePayload(parsedRaw)) {
          throw new Error(`profile payload shape mismatch: ${f.path}`);
        }
        const slug = f.path.split("/").pop()!.replace(/\.json$/, "");
        const trashId = parsedRaw.trash_id ?? slug;
        const name = parsedRaw.name ?? slug;
        return { trashId, name, payload: parsedRaw, file: f };
      }),
    );

    const toUpsert: Array<{
      trashId: string;
      name: string;
      payload: TrashQualityProfile;
      path: string;
      sha: string;
    }> = [];
    for (const r of results) {
      if (r.status !== "fulfilled") {
        const message = r.reason instanceof Error ? r.reason.message : String(r.reason);
        if (message.includes("payload shape mismatch")) validationCounter.count++;
        errors.push(`profile: ${message}`);
        continue;
      }
      fetched++;
      const { trashId, name, payload, file } = r.value;
      if (existingSha.get(`QUALITY_PROFILE::${trashId}`) === file.sha) continue;
      toUpsert.push({ trashId, name, payload, path: file.path, sha: file.sha });
    }

    if (toUpsert.length > 0) {
      await prisma.$transaction(async (tx) => {
        for (const row of toUpsert) {
          await tx.trashSpec.upsert({
            where: { service_kind_trashId: { service, kind: "QUALITY_PROFILE", trashId: row.trashId } },
            update: {
              name: row.name,
              payload: row.payload as unknown as object,
              upstreamPath: row.path,
              upstreamSha: row.sha,
              fetchedAt: now,
            },
            create: {
              service,
              kind: "QUALITY_PROFILE",
              trashId: row.trashId,
              name: row.name,
              payload: row.payload as unknown as object,
              upstreamPath: row.path,
              upstreamSha: row.sha,
              fetchedAt: now,
            },
          });
          updated++;
        }
      }, { timeout: BATCH_TX_TIMEOUT });
    }
  }

  return { fetched, updated };
}

async function refreshQualitySizes(
  service: TrashService,
  trashTree: GhTreeEntry[],
  existingSha: Map<string, string | null>,
  now: Date,
  errors: string[],
  validationCounter: ValidationCounter,
): Promise<{ fetched: number; updated: number }> {
  const dir = TRASH_PATHS[service].qualitySizes;
  const files = trashTree.filter(
    (t) => t.type === "blob" && t.path.startsWith(`${dir}/`) && t.path.endsWith(".json"),
  );

  let fetched = 0;
  let updated = 0;

  for (let i = 0; i < files.length; i += GH_CONCURRENCY) {
    const batch = files.slice(i, i + GH_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (f) => {
        const content = await ghRawFile(TRASH_REPO, TRASH_BRANCH, f.path);
        const parsedRaw = JSON.parse(content) as unknown;
        if (!isQualitySizePayload(parsedRaw)) {
          throw new Error(`quality-size payload shape mismatch: ${f.path}`);
        }
        const slug = f.path.split("/").pop()!.replace(/\.json$/, "");
        const trashId = parsedRaw.trash_id ?? slug;
        const name = parsedRaw.type ?? slug;
        return { trashId, name, payload: parsedRaw, file: f };
      }),
    );

    const toUpsert: Array<{
      trashId: string;
      name: string;
      payload: TrashQualitySize;
      path: string;
      sha: string;
    }> = [];
    for (const r of results) {
      if (r.status !== "fulfilled") {
        const message = r.reason instanceof Error ? r.reason.message : String(r.reason);
        if (message.includes("payload shape mismatch")) validationCounter.count++;
        errors.push(`quality-size: ${message}`);
        continue;
      }
      fetched++;
      const { trashId, name, payload, file } = r.value;
      if (existingSha.get(`QUALITY_SIZE::${trashId}`) === file.sha) continue;
      toUpsert.push({ trashId, name, payload, path: file.path, sha: file.sha });
    }

    if (toUpsert.length > 0) {
      await prisma.$transaction(async (tx) => {
        for (const row of toUpsert) {
          await tx.trashSpec.upsert({
            where: { service_kind_trashId: { service, kind: "QUALITY_SIZE", trashId: row.trashId } },
            update: {
              name: row.name,
              payload: row.payload as unknown as object,
              upstreamPath: row.path,
              upstreamSha: row.sha,
              fetchedAt: now,
            },
            create: {
              service,
              kind: "QUALITY_SIZE",
              trashId: row.trashId,
              name: row.name,
              payload: row.payload as unknown as object,
              upstreamPath: row.path,
              upstreamSha: row.sha,
              fetchedAt: now,
            },
          });
          updated++;
        }
      }, { timeout: BATCH_TX_TIMEOUT });
    }
  }

  return { fetched, updated };
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

    }
    return `${err.status} — ${body.replace(/\s+/g, " ").slice(0, 500)}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

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

async function resolveCfg(service: TrashService): Promise<ArrCfg> {
  const key = service === "RADARR" ? "radarr" : "sonarr";
  const cfg = await getArrCfg(key);
  if (!cfg) throw new Error(`${service} is not configured`);
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
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "P2025";
}

function isPrismaUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "P2002";
}

async function recordApply(
  spec: { id: string; kind: TrashSpecKind; trashId: string; name: string },
  outcome:
    | { ok: true; remoteId?: number; recreated?: boolean }
    | { ok: false; error: string },
): Promise<ApplyResult> {
  // Race-safety: when two `applySpecs` runs interleave on the same spec (admin Apply during a cron
  // run after lock contention is resolved), a read-modify-write on errorCount loses one of the
  // increments. We use update-with-increment, falling back to create on P2025 — the upsert form
  // doesn't support `{ increment: 1 }` inside `update.data`.
  if (outcome.ok) {
    const appliedAt = new Date();
    const updateData = {
      appliedAt,
      lastError: null,
      lastErrorAt: null,
      errorCount: 0,
      enabled: true,
      ...(outcome.remoteId != null ? { remoteId: outcome.remoteId } : {}),
    };
    try {
      await prisma.trashApplication.update({ where: { trashSpecId: spec.id }, data: updateData });
    } catch (err) {
      if (!isPrismaNotFound(err)) throw err;
      try {
        await prisma.trashApplication.create({
          data: { trashSpecId: spec.id, ...updateData },
        });
      } catch (createErr) {
        // P2002 = a concurrent path created the row between our failed update and our create.
        // The advisory lock at the route boundary normally prevents this, but defending here is
        // cheap insurance against future code that forgets the lock invariant.
        if (!isPrismaUniqueViolation(createErr)) throw createErr;
        await prisma.trashApplication.update({ where: { trashSpecId: spec.id }, data: updateData });
      }
    }
  } else {
    const lastErrorAt = new Date();
    const failureUpdate = {
      lastError: outcome.error,
      lastErrorAt,
      errorCount: { increment: 1 },
    };
    try {
      await prisma.trashApplication.update({
        where: { trashSpecId: spec.id },
        data: failureUpdate,
      });
    } catch (err) {
      if (!isPrismaNotFound(err)) throw err;
      try {
        await prisma.trashApplication.create({
          data: {
            trashSpecId: spec.id,
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
          where: { trashSpecId: spec.id },
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

export async function applyCustomFormats(
  service: TrashService,
  specIds: string[],
): Promise<ApplyResult[]> {
  const cfg = await resolveCfg(service);
  const specs = await prisma.trashSpec.findMany({
    where: { id: { in: specIds }, service, kind: "CUSTOM_FORMAT" },
    include: { application: true },
  });
  if (specs.length === 0) return [];

  let remoteByName = new Map<string, number>();
  try {
    const remote = await arrFetch<Array<{ id: number; name: string }>>(cfg, "/api/v3/customformat");
    remoteByName = new Map(remote.map((r) => [r.name, r.id]));
  } catch {

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
      const remoteId = spec.application?.remoteId ?? remoteByName.get(payload.name) ?? null;
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
      results.push(await recordApply(spec, { ok: true, remoteId: created.id, recreated }));
    } catch (err) {
      results.push(await recordApply(spec, { ok: false, error: formatArrError(err) }));
    }
  }
  return results;
}

export async function applyCustomFormatGroups(
  service: TrashService,
  specIds: string[],
): Promise<ApplyResult[]> {
  const groups = await prisma.trashSpec.findMany({
    where: { id: { in: specIds }, service, kind: "CUSTOM_FORMAT_GROUP" },
  });
  if (groups.length === 0) return [];

  // Collect every referenced member trash_id across all selected groups, then
  // resolve them to local TrashSpec rows in a single query — duplicates collapse naturally
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

  // Apply every member CF in one batch — applyCustomFormats handles dedup of remoteIds
  const allCfSpecIds = [...new Set(memberSpecs.map((s) => s.id))];
  const cfResults = allCfSpecIds.length > 0 ? await applyCustomFormats(service, allCfSpecIds) : [];
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
      }));
      continue;
    }
    if (failedRequired.length > 0) {
      const names = failedRequired.slice(0, 3).map((m) => m.name).join(", ");
      const more = failedRequired.length > 3 ? ` (+${failedRequired.length - 3} more)` : "";
      results.push(await recordApply(g, {
        ok: false,
        error: `Required CF apply failed: ${names}${more}`,
      }));
      continue;
    }
    results.push(await recordApply(g, { ok: true }));
  }
  return results;
}

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
  const std = pick(episodes, "standard") ?? pick(episodes, "default");
  const daily = pick(episodes, "daily");
  const anime = pick(episodes, "anime");
  const seriesFolder = pick(series, "default");
  const seasonFolder = pick(season, "default");
  if (std) patch.standardEpisodeFormat = std;
  if (daily) patch.dailyEpisodeFormat = daily;
  if (anime) patch.animeEpisodeFormat = anime;
  if (seriesFolder) patch.seriesFolderFormat = seriesFolder;
  if (seasonFolder) patch.seasonFolderFormat = seasonFolder;
  return patch;
}

export async function applyNaming(
  service: TrashService,
  specIds: string[],
): Promise<ApplyResult[]> {
  const cfg = await resolveCfg(service);
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
    await arrFetch<unknown>(cfg, `/api/v3/config/naming`, {
      method: "PUT",
      body: JSON.stringify(merged),
    });
    const results: ApplyResult[] = [];
    for (const spec of specs) results.push(await recordApply(spec, { ok: true }));
    return results;
  } catch (err) {
    const message = formatArrError(err);
    const results: ApplyResult[] = [];
    for (const spec of specs) results.push(await recordApply(spec, { ok: false, error: message }));
    return results;
  }
}

export async function applyQualitySizes(
  service: TrashService,
  specIds: string[],
): Promise<ApplyResult[]> {
  const cfg = await resolveCfg(service);
  const specs = await prisma.trashSpec.findMany({
    where: { id: { in: specIds }, service, kind: "QUALITY_SIZE" },
  });
  if (specs.length === 0) return [];

  try {

    // Multiple specs may reference the same quality name; last writer wins when merging
    const combined = new Map<string, { min: number; preferred?: number; max: number }>();
    for (const spec of specs) {
      const payload = spec.payload as unknown as TrashQualitySize;
      for (const q of payload.qualities ?? []) {
        combined.set(q.quality, { min: q.min, preferred: q.preferred, max: q.max });
      }
    }

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

    await arrFetch<unknown>(cfg, "/api/v3/qualitydefinition/update", {
      method: "PUT",
      body: JSON.stringify(merged),
    });

    const results: ApplyResult[] = [];
    for (const spec of specs) results.push(await recordApply(spec, { ok: true }));
    return results;
  } catch (err) {
    const message = formatArrError(err);
    const results: ApplyResult[] = [];
    for (const spec of specs) results.push(await recordApply(spec, { ok: false, error: message }));
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

async function buildProfileBody(
  cfg: ArrCfg,
  service: TrashService,
  profile: TrashQualityProfile,
): Promise<Record<string, unknown>> {
  type RemoteCf = { id: number; name: string; specifications?: Array<{ fields?: Array<{ name?: string; value?: unknown }> }> };

  const [schema, remoteLanguages] = await Promise.all([
    arrFetch<Record<string, unknown>>(cfg, "/api/v3/qualityprofile/schema"),
    arrFetch<Array<{ id: number; name: string }>>(cfg, "/api/v3/language").catch(() => [] as Array<{ id: number; name: string }>),
  ]);

  const schemaItems = (schema.items as RemoteQualityItem[] | undefined) ?? [];

  const referencedTrashIds = new Set<string>(Object.values(profile.formatItems ?? {}));
  const applications = await prisma.trashApplication.findMany({
    where: {
      enabled: true,
      trashSpec: { service, kind: "CUSTOM_FORMAT", trashId: { in: [...referencedTrashIds] } },
    },
    include: { trashSpec: true },
  });
  const appliedByTrashId = new Map(
    applications
      .filter((a) => a.remoteId != null)
      .map((a) => [a.trashSpec.trashId, a.remoteId as number]),
  );
  const specsMissingApplication = await prisma.trashSpec.findMany({
    where: {
      service,
      kind: "CUSTOM_FORMAT",
      trashId: { in: [...referencedTrashIds].filter((id) => !appliedByTrashId.has(id)) },
    },
  });
  if (specsMissingApplication.length > 0) {
    const depResults = await applyCustomFormats(
      service,
      specsMissingApplication.map((s) => s.id),
    );
    for (const r of depResults) {
      if (r.ok && r.remoteId != null) appliedByTrashId.set(r.trashId, r.remoteId);
    }
  }

  const remoteCfs = await arrFetch<RemoteCf[]>(cfg, "/api/v3/customformat");

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

  const wantedNames = new Set<string>();
  for (const q of profile.items ?? []) {
    if (q.allowed) {
      wantedNames.add(q.name);
      for (const sub of q.items ?? []) wantedNames.add(sub);
    }
  }
  const items: RemoteQualityItem[] = schemaItems.map((item) => {
    if (item.items?.length) {
      const allowed = wantedNames.has(item.name ?? "");
      return {
        ...item,
        allowed,
        items: item.items.map((sub) => ({
          ...sub,
          allowed: allowed && (sub.quality ? wantedNames.has(sub.quality.name) : false),
        })),
      };
    }
    if (item.quality) {
      return { ...item, allowed: wantedNames.has(item.quality.name) };
    }
    return { ...item, allowed: false };
  });

  const cutoffName = profile.cutoff ?? "";
  let cutoff: number | undefined;
  for (const item of items) {
    if (item.items?.length && item.name === cutoffName) {
      cutoff = (item as { id?: number }).id;
      if (cutoff != null) break;
    }
    if (!item.items?.length && item.quality?.name === cutoffName) {
      cutoff = item.quality.id;
      break;
    }
  }

  const scoreSet = profile.score_set ?? "default";
  const specsForScores = await prisma.trashSpec.findMany({
    where: { service, kind: "CUSTOM_FORMAT", trashId: { in: [...referencedTrashIds] } },
  });
  const specByTrashId = new Map(specsForScores.map((s) => [s.trashId, s]));
  const scoreByTrashId = new Map<string, number>();
  for (const trashId of referencedTrashIds) {
    const spec = specByTrashId.get(trashId);
    const trashScores = (spec?.payload as unknown as TrashCustomFormat | null)?.trash_scores;
    const score = trashScores?.[scoreSet] ?? trashScores?.default ?? 0;
    scoreByTrashId.set(trashId, score);
  }
  const formatItems: RemoteFormatItem[] = remoteCfs.map((cf) => {
    let trashId: string | undefined;
    for (const [tid, rid] of appliedByTrashId.entries()) {
      if (rid === cf.id) {
        trashId = tid;
        break;
      }
    }
    const score = trashId ? scoreByTrashId.get(trashId) ?? 0 : 0;
    return { format: cf.id, name: cf.name, score };
  });

  let language: { id: number; name: string } | undefined;
  const wantLang = (profile.language ?? "").toLowerCase();
  if (wantLang === "original" || wantLang === "") {
    language = remoteLanguages.find((l) => l.name.toLowerCase() === "original") ?? { id: -1, name: "Original" };
  } else if (wantLang === "any") {
    language = remoteLanguages.find((l) => l.name.toLowerCase() === "any") ?? { id: -2, name: "Any" };
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

export async function applyQualityProfiles(
  service: TrashService,
  specIds: string[],
): Promise<ApplyResult[]> {
  const cfg = await resolveCfg(service);
  const specs = await prisma.trashSpec.findMany({
    where: { id: { in: specIds }, service, kind: "QUALITY_PROFILE" },
    include: { application: true },
  });
  if (specs.length === 0) return [];

  let remoteByName = new Map<string, number>();
  try {
    const remote = await arrFetch<Array<{ id: number; name: string }>>(cfg, "/api/v3/qualityprofile");
    remoteByName = new Map(remote.map((r) => [r.name, r.id]));
  } catch {

  }

  const results: ApplyResult[] = [];
  for (const spec of specs) {
    try {
      const profile = spec.payload as unknown as TrashQualityProfile;
      const body = await buildProfileBody(cfg, service, profile);
      const remoteId = spec.application?.remoteId ?? remoteByName.get(profile.name) ?? null;
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
      results.push(await recordApply(spec, { ok: true, remoteId: created.id, recreated }));
    } catch (err) {
      results.push(await recordApply(spec, { ok: false, error: formatArrError(err) }));
    }
  }
  return results;
}

export async function applySpecs(specIds: string[]): Promise<ApplyResult[]> {
  const specs = await prisma.trashSpec.findMany({
    where: { id: { in: specIds } },
    select: { id: true, service: true, kind: true, payload: true },
  });

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
    if (kind === "CUSTOM_FORMAT") all.push(...(await applyCustomFormats(service, ids)));
    else if (kind === "CUSTOM_FORMAT_GROUP") all.push(...(await applyCustomFormatGroups(service, ids)));
    else if (kind === "NAMING") all.push(...(await applyNaming(service, ids)));
    else if (kind === "QUALITY_PROFILE") all.push(...(await applyQualityProfiles(service, ids)));
    else if (kind === "QUALITY_SIZE") all.push(...(await applyQualitySizes(service, ids)));
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

export async function runTrashSync(): Promise<TrashSyncResult> {
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
    for (const service of services) {
      try {
        const r = await refreshCatalog(service);
        refreshed.push(r);
        errors.push(...r.errors.map((e) => `${service}: ${e}`));
      } catch (err) {
        errors.push(`${service} refresh: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // Only stamp success if at least one service refreshed without throwing — partial-success here
    // is intentional, the gate is "we recently tried", not "the catalog is exhaustively current".
    if (refreshed.length > 0) {
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

  const applications = await prisma.trashApplication.findMany({
    where: { enabled: true, trashSpec: { kind: { in: enabledKinds } } },
    select: { trashSpecId: true },
  });
  const applied = applications.length
    ? await applySpecs(applications.map((a) => a.trashSpecId))
    : [];

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

export async function listSpecs(service: TrashService): Promise<SpecStatus[]> {
  const rows = await prisma.trashSpec.findMany({
    where: { service },
    include: { application: true },
    orderBy: [{ kind: "asc" }, { name: "asc" }],
  });
  return rows.map((r) => ({
    id: r.id,
    service: r.service,
    kind: r.kind,
    trashId: r.trashId,
    name: r.name,
    description: r.description,
    fetchedAt: r.fetchedAt.toISOString(),
    application: r.application
      ? {
          id: r.application.id,
          enabled: r.application.enabled,
          remoteId: r.application.remoteId,
          appliedAt: r.application.appliedAt?.toISOString() ?? null,
          lastError: r.application.lastError,
          lastErrorAt: r.application.lastErrorAt?.toISOString() ?? null,
          errorCount: r.application.errorCount,
        }
      : null,
  }));
}

export interface SpecDetail extends SpecStatus {
  upstreamPath: string;
  upstreamSha: string | null;
  payload: unknown;
}

export async function getSpecDetail(id: string): Promise<SpecDetail | null> {
  const row = await prisma.trashSpec.findUnique({
    where: { id },
    include: { application: true },
  });
  if (!row) return null;
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
    application: row.application
      ? {
          id: row.application.id,
          enabled: row.application.enabled,
          remoteId: row.application.remoteId,
          appliedAt: row.application.appliedAt?.toISOString() ?? null,
          lastError: row.application.lastError,
          lastErrorAt: row.application.lastErrorAt?.toISOString() ?? null,
          errorCount: row.application.errorCount,
        }
      : null,
  };
}
