// Custom formats and CF-Groups → Radarr/Sonarr.
import { prisma } from "./prisma";
import type { ArrCfg, ArrVariant } from "./arr";
import {
  arrRead,
  formatArrError,
  indexRemote,
  isRecord,
  recordAllFailed,
  recordApplies,
  RemoteCfListSchema,
  resolveCfg,
  resolveRemoteId,
  STORED_PAYLOAD_INVALID,
  storedPayload,
  toArrInstance,
  upsertRemote,
  type ApplyOutcome,
  type RemoteCf,
} from "./trash-apply-common";
import { isCustomFormatGroupPayload, isCustomFormatPayload } from "./trash-validators";
import type { ApplyOptions, ApplyResult, TrashCustomFormatGroup } from "./trash-types";
import type { TrashService } from "@/generated/prisma";

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

// Projection for the no-op compare: exactly the fields the PUT body writes,
// applied to BOTH sides so extra metadata on either side (remote
// implementationName/infoLink/field labels, TRaSH trash_scores) can't defeat
// equality. STRICT on absence — a remote row that omits a field the body
// sets stays unequal and still PUTs (drift repair is the feature).
function projectCfForCompare(cf: { name?: unknown; includeCustomFormatWhenRenaming?: unknown; specifications?: unknown }): string {
  const specifications = Array.isArray(cf.specifications) ? cf.specifications : [];
  return JSON.stringify({
    name: cf.name,
    includeCustomFormatWhenRenaming: cf.includeCustomFormatWhenRenaming ?? false,
    specifications: specifications.map((s) => {
      const spec = isRecord(s) ? s : {};
      return {
        name: spec.name,
        implementation: spec.implementation,
        negate: spec.negate,
        required: spec.required,
        fields: Array.isArray(spec.fields)
          ? spec.fields.map((f) => (isRecord(f) ? { name: f.name, value: f.value } : { name: undefined, value: undefined }))
          : [],
      };
    }),
  });
}

// The cron re-applies every enabled spec each run to repair drift (changes made
// by hand in Radarr/Sonarr). A remote CF that already matches what we'd PUT
// needs no write. Equality is trusted only when the remote row CARRIES its
// specifications array — a row without it (truncated response) is unknown
// state, and treating absence as "empty" would wrongly skip the PUT for a
// spec-less body.
function remoteMatches(remoteRow: RemoteCf | undefined, body: Record<string, unknown>): boolean {
  return remoteRow !== undefined
    && Array.isArray(remoteRow.specifications)
    && projectCfForCompare(remoteRow) === projectCfForCompare(body);
}

type RemoteIndex = ReturnType<typeof indexRemote<RemoteCf>>;

async function applyOneCustomFormat(
  cfg: ArrCfg,
  spec: { payload: unknown; applications: Array<{ remoteId: number | null }> },
  remote: RemoteIndex,
): Promise<ApplyOutcome> {
  const payload = storedPayload(spec, isCustomFormatPayload);
  if (!payload) return { ok: false, error: STORED_PAYLOAD_INVALID };
  const body = {
    name: payload.name,
    includeCustomFormatWhenRenaming: payload.includeCustomFormatWhenRenaming ?? false,
    specifications: normalizeSpecFields(payload.specifications ?? []),
  };
  try {
    // PUT if remoteId is known (update existing); POST only for truly new CFs to avoid duplicate creation.
    // upsertRemote transparently recovers if the resource was deleted in the Arr UI between
    // Summonarr's last apply and now (PUT → 404 → POST).
    const remoteId = resolveRemoteId(spec.applications[0]?.remoteId, payload.name, remote.nameById, remote.idByName);
    if (remoteId && remoteMatches(remote.byId.get(remoteId), body)) return { ok: true, remoteId };
    return { ok: true, ...(await upsertRemote(cfg, "/api/v3/customformat", remoteId, body)) };
  } catch (err) {
    return { ok: false, error: formatArrError(err) };
  }
}

// Pushes the given CUSTOM_FORMAT specs to the Radarr/Sonarr instance for `variant` (PUT existing / POST new), recording each outcome.
// The arr writes run one spec at a time; the lock's signal (guardrail 41) is
// checked before each, and an aborted run records and returns what it did.
export async function applyCustomFormats(
  service: TrashService,
  specIds: string[],
  variant: ArrVariant = "hd",
  opts: ApplyOptions = {},
): Promise<ApplyResult[]> {
  const arrInstance = toArrInstance(variant);
  const cfg = await resolveCfg(service, variant);
  const specs = await prisma.trashSpec.findMany({
    where: { id: { in: specIds }, service, kind: "CUSTOM_FORMAT" },
    include: { applications: { where: { arrInstance } } },
  });
  if (specs.length === 0) return [];

  let remote: RemoteIndex;
  try {
    remote = indexRemote(await arrRead(cfg, "/api/v3/customformat", RemoteCfListSchema));
  } catch (err) {
    // Can't read existing CFs → can't tell new from existing, so a blind POST in
    // the loop below would create duplicates. Fail the whole batch instead of
    // guessing, and log a warning so the failure is visible.
    console.warn("[trash] failed to prefetch remote customformat list:", err instanceof Error ? err.message : err);
    return recordAllFailed(specs, "Could not read existing custom formats from the *arr instance", arrInstance);
  }

  const entries: Array<{ spec: (typeof specs)[number]; outcome: ApplyOutcome }> = [];
  for (const spec of specs) {
    if (opts.signal?.aborted) break;
    entries.push({ spec, outcome: await applyOneCustomFormat(cfg, spec, remote) });
  }
  return recordApplies(entries, arrInstance);
}

// The member trash_ids a CF-Group lists.
export function groupMemberTrashIds(payload: TrashCustomFormatGroup | null): string[] {
  return payload ? payload.custom_formats.map((m) => m.trash_id) : [];
}

// A group is "ok" when every required member resolved and applied.
function groupOutcome(
  payload: TrashCustomFormatGroup | null,
  cfSpecIdByTrashId: Map<string, string>,
  memberResultByTrashId: Map<string, ApplyResult>,
): ApplyOutcome {
  if (!payload) return { ok: false, error: STORED_PAYLOAD_INVALID };
  const memberIds = groupMemberTrashIds(payload);
  const missing = memberIds.filter((id) => !cfSpecIdByTrashId.has(id));
  if (missing.length === memberIds.length && memberIds.length > 0) {
    return {
      ok: false,
      error: `No member custom formats found in catalog (${memberIds.length} expected). Refresh Catalog first.`,
    };
  }
  const failedRequired = payload.custom_formats.filter(
    (m) => m.required && memberResultByTrashId.get(m.trash_id)?.ok !== true,
  );
  if (failedRequired.length > 0) {
    const names = failedRequired.slice(0, 3).map((m) => m.name || m.trash_id).join(", ");
    const more = failedRequired.length > 3 ? ` (+${failedRequired.length - 3} more)` : "";
    return { ok: false, error: `Required CF apply failed: ${names}${more}` };
  }
  return { ok: true };
}

export interface GroupApplyResults {
  groups: ApplyResult[];
  // The member custom formats the groups pushed, one result per spec.
  members: ApplyResult[];
}

// Applies CF-Group specs by cascading their member CFs through applyCustomFormats, then rolls up per-group ok/fail on required members.
// Returns the member CFs' own results too: a failed optional member doesn't
// fail its group, but it is still a failed write the caller must report.
export async function applyCustomFormatGroupsWithMembers(
  service: TrashService,
  specIds: string[],
  variant: ArrVariant = "hd",
  opts: ApplyOptions = {},
): Promise<GroupApplyResults> {
  const arrInstance = toArrInstance(variant);
  const groups = await prisma.trashSpec.findMany({
    where: { id: { in: specIds }, service, kind: "CUSTOM_FORMAT_GROUP" },
  });
  if (groups.length === 0) return { groups: [], members: [] };

  // Collect every referenced member trash_id, then resolve to local TrashSpec rows in one query
  const payloadById = new Map(groups.map((g) => [g.id, storedPayload(g, isCustomFormatGroupPayload)]));
  const memberTrashIds = new Set<string>();
  for (const payload of payloadById.values()) {
    for (const id of groupMemberTrashIds(payload)) memberTrashIds.add(id);
  }
  const memberSpecs = await prisma.trashSpec.findMany({
    where: { service, kind: "CUSTOM_FORMAT", trashId: { in: [...memberTrashIds] } },
    select: { id: true, trashId: true, name: true },
  });
  const cfSpecIdByTrashId = new Map(memberSpecs.map((s) => [s.trashId, s.id]));

  // Apply every member CF in one batch. The Set means a CF shared by several groups is applied once.
  const allCfSpecIds = [...new Set(memberSpecs.map((s) => s.id))];
  const members = allCfSpecIds.length > 0 ? await applyCustomFormats(service, allCfSpecIds, variant, opts) : [];
  // A member pass the lock cut short would read as failed required members.
  if (opts.signal?.aborted) return { groups: [], members };
  const memberResultByTrashId = new Map(members.map((r) => [r.trashId, r]));

  const outcomes = groups.map((g) => ({
    spec: g,
    outcome: groupOutcome(payloadById.get(g.id) ?? null, cfSpecIdByTrashId, memberResultByTrashId),
  }));
  return { groups: await recordApplies(outcomes, arrInstance), members };
}

// The groups' own results only; the member CFs are applied and recorded, and
// applySpecs reports them through applyCustomFormatGroupsWithMembers.
export async function applyCustomFormatGroups(
  service: TrashService,
  specIds: string[],
  variant: ArrVariant = "hd",
  opts: ApplyOptions = {},
): Promise<ApplyResult[]> {
  return (await applyCustomFormatGroupsWithMembers(service, specIds, variant, opts)).groups;
}
