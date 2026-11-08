// What every TRaSH applier shares: the instance config, the arr response
// shapes, the PUT-or-POST write, the TrashApplication bookkeeping and the
// error text an admin sees.
import { prisma } from "./prisma";
import { arrFetch, ArrResponseError, getArrCfg, type ArrCfg, type ArrVariant } from "./arr";
import { safeMessage } from "./arr-parse";
import { mapLimit } from "./concurrency";
import { isPrismaErrorCode } from "./prisma-errors";
import { check, v, type Infer, type Schema } from "./validate";
import type { ApplyResult, SpecIdentity } from "./trash-types";
import type { TrashService } from "@/generated/prisma";

// Bounds the recordApply() fan-out (guardrail 31): an admin can have applied
// hundreds of custom formats, and each record is its own upsert. Below the
// pool's five connections, so the sync never holds all of them.
const RECORD_APPLY_CONCURRENCY = 4;

// Shown on a spec whose stored payload fails its validator: a row written by an
// older version, or edited by hand. The next refresh of a changed file rewrites it.
export const STORED_PAYLOAD_INVALID =
  "The stored TRaSH definition is malformed, so it was not applied. Refresh the catalog to fetch it again.";

// The TrashApplication.arrInstance for an apply variant: "hd" is the legacy
// spelling of the default instance "".
export function toArrInstance(variant: ArrVariant): string {
  return variant === "hd" ? "" : variant;
}

// The instance an apply names has no URL/API key. applySpecs records nothing
// for it: there is no instance to have failed against (it tells by the name).
class ArrNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArrNotConfiguredError";
  }
}

export async function resolveCfg(service: TrashService, variant: ArrVariant = "hd"): Promise<ArrCfg> {
  const key = service === "RADARR" ? "radarr" : "sonarr";
  const cfg = await getArrCfg(key, variant);
  if (!cfg) {
    const instance = toArrInstance(variant);
    throw new ArrNotConfiguredError(`${service}${instance ? ` (${instance})` : ""} is not configured`);
  }
  return cfg;
}

// ── arr response shapes ──────────────────────────────────────────────────────

// A schema check as a type guard on the ORIGINAL value. `check` returns a copy
// holding only the declared keys; a body this module sends back (the naming
// config, the quality definitions, a profile's quality items) must keep every
// field the arr sent, so those keep the value they checked.
export function conforms<S extends Schema<unknown>>(schema: S, value: unknown): value is Infer<S> {
  return check(schema, value).ok;
}

// Reads an arr GET and checks it, so a malformed answer fails here with its
// path instead of as a TypeError deep in an applier. The checked copy holds
// only what the schema declares (a v.record keeps every key).
export async function arrRead<S extends Schema<unknown>>(cfg: ArrCfg, path: string, schema: S): Promise<Infer<S>> {
  const parsed = check(schema, await arrFetch<unknown>(cfg, path));
  if (!parsed.ok) throw new Error(`Unexpected response from ${path}: ${parsed.error}`);
  return parsed.value;
}

// `value` itself once it passes `schema`; else an error naming `what` and the
// path that failed.
export function checkedWhole<S extends Schema<unknown>>(schema: S, value: unknown, what: string): Infer<S> {
  if (conforms(schema, value)) return value;
  const parsed = check(schema, value);
  throw new Error(`Unexpected response from ${what}: ${parsed.ok ? "unreadable" : parsed.error}`);
}

// arrRead for an answer that is sent back: checked, but the arr's own value,
// every field it carries kept.
export async function arrReadWhole<S extends Schema<unknown>>(cfg: ArrCfg, path: string, schema: S): Promise<Infer<S>> {
  return checkedWhole(schema, await arrFetch<unknown>(cfg, path), path);
}

export const NamedIdListSchema = v.array(v.object({ id: v.int(), name: v.string() }));

// A remote custom format: what the no-op compare and the trash_id scan read.
// The compared fields stay `unknown` so the compare sees exactly what arrived.
export const RemoteCfListSchema = v.array(v.object({
  id: v.int(),
  name: v.string(),
  includeCustomFormatWhenRenaming: v.optional(v.unknown()),
  specifications: v.optional(v.unknown()),
}));
export type RemoteCf = Infer<typeof RemoteCfListSchema>[number];

// The live custom formats by id and by name, for resolveRemoteId.
export function indexRemote<R extends { id: number; name: string }>(rows: readonly R[]) {
  const byId = new Map<number, R>();
  const nameById = new Map<number, string>();
  const idByName = new Map<string, number>();
  for (const r of rows) {
    byId.set(r.id, r);
    nameById.set(r.id, r.name);
    idByName.set(r.name, r.id);
  }
  return { byId, nameById, idByName };
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
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

// ── writes ───────────────────────────────────────────────────────────────────

// Update an Arr resource by remoteId (PUT), recovering with a POST if Radarr/Sonarr returns 404.
// Returns the resource and a flag so callers can audit the recreate. Does NOT clear the old remoteId
// before the POST succeeds — losing the mapping mid-call would accumulate duplicate resources.
async function arrPutOrRecreate(
  cfg: ArrCfg,
  putPath: string,
  postPath: string,
  putBody: object,
  postBody: object,
): Promise<{ resource: unknown; recreated: boolean }> {
  try {
    const resource = await arrFetch<unknown>(cfg, putPath, { method: "PUT", body: JSON.stringify(putBody) });
    return { resource, recreated: false };
  } catch (err) {
    if (err instanceof ArrResponseError && err.status === 404) {
      // Resource was deleted in the Arr UI between Summonarr's last apply and now. Recreate it.
      // The recreate POST is intentionally not wrapped in retry logic — a second 404 is a real failure.
      const resource = await arrFetch<unknown>(cfg, postPath, { method: "POST", body: JSON.stringify(postBody) });
      return { resource, recreated: true };
    }
    throw err;
  }
}

function resourceId(resource: unknown): number | undefined {
  const id = isRecord(resource) ? resource.id : undefined;
  return typeof id === "number" && Number.isSafeInteger(id) ? id : undefined;
}

// PUTs `body` to the resource at `remoteId` (recreating it on a 404), or POSTs
// it when there is none. The PUT's own id goes LAST, so an `id` the body
// carries (a profile body starts from the arr's schema) can't retarget it.
export async function upsertRemote(
  cfg: ArrCfg,
  collection: string,
  remoteId: number | null,
  body: Record<string, unknown>,
): Promise<{ remoteId?: number; recreated: boolean }> {
  if (remoteId) {
    const out = await arrPutOrRecreate(cfg, `${collection}/${remoteId}`, collection, { ...body, id: remoteId }, body);
    // A PUT that answers without an id still wrote to `remoteId`.
    return { remoteId: resourceId(out.resource) ?? (out.recreated ? undefined : remoteId), recreated: out.recreated };
  }
  const created = await arrFetch<unknown>(cfg, collection, { method: "POST", body: JSON.stringify(body) });
  return { remoteId: resourceId(created), recreated: false };
}

// The error text stored on the application and shown to the admin: the arr's
// own validation messages when it sent them, credentials masked (guardrail 5e).
export function formatArrError(err: unknown): string {
  if (err instanceof ArrResponseError) {
    const body = err.body.slice(0, 2000);
    const text = arrBodyMessage(body) ?? body.replace(/\s+/g, " ").slice(0, 500);
    return `${err.status} — ${safeMessage(text, 500) ?? ""}`.trimEnd();
  }
  if (err instanceof Error) return safeMessage(err.message, 500) ?? err.name;
  return safeMessage(String(err), 500) ?? "Unknown error";
}

// A Radarr/Sonarr error body: a list of validation failures, or one object
// with a message. Null when it is neither (plain text, or JSON of another shape).
function arrBodyMessage(body: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return null;
  }
  if (Array.isArray(parsed)) {
    const messages = parsed.map((entry) => {
      if (!isRecord(entry)) return JSON.stringify(entry);
      const prop = typeof entry.propertyName === "string" && entry.propertyName ? `${entry.propertyName}: ` : "";
      const message = entry.errorMessage ?? entry.message;
      return `${prop}${typeof message === "string" ? message : JSON.stringify(entry)}`;
    });
    return messages.length > 0 ? messages.join("; ") : null;
  }
  if (isRecord(parsed)) {
    const msg = parsed.message ?? parsed.error ?? JSON.stringify(parsed);
    return String(msg).slice(0, 500);
  }
  return null;
}

// ── TrashApplication bookkeeping ─────────────────────────────────────────────

export type ApplyOutcome =
  | { ok: true; remoteId?: number; recreated?: boolean }
  | { ok: false; error: string };

export function toApplyResult(spec: SpecIdentity, outcome: ApplyOutcome): ApplyResult {
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

// Race-safety: when two `applySpecs` runs interleave on the same spec (admin Apply during a cron
// run after lock contention is resolved), a read-modify-write on errorCount loses one of the
// increments. The failure path uses update-with-increment + P2025 fallback for that reason.
// The success path doesn't increment, so a single `upsert` is atomic.
export async function recordApply(
  spec: SpecIdentity,
  outcome: ApplyOutcome,
  arrInstance: string,
): Promise<ApplyResult> {
  if (outcome.ok) await recordSuccess(spec.id, arrInstance, outcome.remoteId);
  else await recordFailure(spec.id, arrInstance, outcome.error);
  return toApplyResult(spec, outcome);
}

async function recordSuccess(trashSpecId: string, arrInstance: string, remoteId: number | undefined): Promise<void> {
  // `enabled` is deliberately NOT in the shared payload. It belongs on CREATE — a
  // brand-new application starts enabled — but writing it on UPDATE silently reverts
  // an admin's explicit disable: the cron only applies `enabled: true` rows, but a
  // manual apply (/api/admin/trash-guides/apply names specIds directly) and the
  // dependency cascade both reach a disabled row, and a successful outcome then
  // turned the toggle back on with nothing in the UI to explain it.
  const successUpdate = {
    appliedAt: new Date(),
    lastError: null,
    lastErrorAt: null,
    errorCount: 0,
    ...(remoteId != null ? { remoteId } : {}),
  };
  await prisma.trashApplication.upsert({
    where: { trashSpecId_arrInstance: { trashSpecId, arrInstance } },
    update: successUpdate,
    create: { trashSpecId, arrInstance, enabled: true, ...successUpdate },
  });
}

async function recordFailure(trashSpecId: string, arrInstance: string, error: string): Promise<void> {
  const where = { trashSpecId_arrInstance: { trashSpecId, arrInstance } };
  const lastErrorAt = new Date();
  const failureUpdate = { lastError: error, lastErrorAt, errorCount: { increment: 1 } };
  if (await incrementFailure(where, failureUpdate)) return;
  try {
    await prisma.trashApplication.create({
      data: { trashSpecId, arrInstance, lastError: error, lastErrorAt, errorCount: 1 },
    });
  } catch (createErr) {
    if (!isPrismaErrorCode(createErr, "P2002")) throw createErr;
    // Concurrent create from another path won the race — increment our count via update instead
    // so the failure tally still reflects this attempt.
    await prisma.trashApplication.update({ where, data: failureUpdate });
  }
}

// False when the application row doesn't exist yet.
async function incrementFailure(
  where: { trashSpecId_arrInstance: { trashSpecId: string; arrInstance: string } },
  data: { lastError: string; lastErrorAt: Date; errorCount: { increment: number } },
): Promise<boolean> {
  try {
    await prisma.trashApplication.update({ where, data });
    return true;
  } catch (err) {
    if (isPrismaErrorCode(err, "P2025")) return false;
    throw err;
  }
}

// Records a batch of outcomes, RECORD_APPLY_CONCURRENCY at a time, in input
// order. A record that fails still answers the outcome the arr gave (its
// application row keeps its previous state), so one DB blip can't turn an
// applied spec into a reported failure or sink its siblings.
export function recordApplies(
  entries: ReadonlyArray<{ spec: SpecIdentity; outcome: ApplyOutcome }>,
  arrInstance: string,
): Promise<ApplyResult[]> {
  return mapLimit(entries, RECORD_APPLY_CONCURRENCY, async ({ spec, outcome }) => {
    try {
      return await recordApply(spec, outcome, arrInstance);
    } catch (err) {
      console.warn("[trash] could not record an apply:", err instanceof Error ? err.message : err);
      return toApplyResult(spec, outcome);
    }
  });
}

// One failure recorded against every spec in a batch.
export function recordAllFailed(specs: readonly SpecIdentity[], error: string, arrInstance: string): Promise<ApplyResult[]> {
  return recordApplies(specs.map((spec) => ({ spec, outcome: { ok: false, error } })), arrInstance);
}

// The validated payload of a stored spec, or null when it fails its guard.
export function storedPayload<T>(spec: { payload: unknown }, guard: (v: unknown) => v is T): T | null {
  return guard(spec.payload) ? spec.payload : null;
}
