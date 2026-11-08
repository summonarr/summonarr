// Quality profiles → Radarr/Sonarr: each TRaSH profile becomes a full profile
// body (the arr's schema, TRaSH's quality ranking, custom-format scores, the
// language), its missing custom formats applied first.
import { prisma } from "./prisma";
import type { ArrCfg, ArrVariant } from "./arr";
import { v } from "./validate";
import { applyCustomFormats } from "./trash-apply-cf";
import {
  arrRead,
  checkedWhole,
  formatArrError,
  indexRemote,
  isRecord,
  NamedIdListSchema,
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
import { buildProfileItems, SchemaQualityItemsSchema, type ProfileQualityItem, type SchemaQualityItem } from "./trash-profile-items";
import { isCustomFormatPayload, isQualityProfilePayload } from "./trash-validators";
import type { ApplyOptions, ApplyResult, TrashQualityProfile } from "./trash-types";
import type { TrashService, TrashSpec } from "@/generated/prisma";

interface RemoteFormatItem {
  format: number;
  name: string;
  score: number;
}

type Language = { id: number; name: string };

// Remote Radarr/Sonarr state a profile body is built from, read once per batch
// by applyQualityProfiles and shared by every profile in it.
interface ProfileBuildRemotes {
  schema: Record<string, unknown>;
  schemaItems: SchemaQualityItem[];
  remoteLanguages: Language[];
  remoteCfs: RemoteCf[];
}

// The profile schema keeps every key the arr sent (it is the base of the body);
// its quality items are checked in place, for the same reason.
async function readProfileSchema(cfg: ArrCfg): Promise<Pick<ProfileBuildRemotes, "schema" | "schemaItems">> {
  const path = "/api/v3/qualityprofile/schema";
  const schema = await arrRead(cfg, path, v.record(v.unknown()));
  return { schema, schemaItems: checkedWhole(SchemaQualityItemsSchema, schema.items ?? [], `${path} items`) };
}

// Best-effort: without the arr's list, the language falls back to the pseudo-ids below.
function readLanguages(cfg: ArrCfg): Promise<Language[]> {
  return arrRead(cfg, "/api/v3/language", NamedIdListSchema).catch(() => [] as Language[]);
}

async function readProfileRemotes(cfg: ArrCfg): Promise<ProfileBuildRemotes> {
  const [profileSchema, remoteLanguages, remoteCfs] = await Promise.all([
    readProfileSchema(cfg),
    readLanguages(cfg),
    arrRead(cfg, "/api/v3/customformat", RemoteCfListSchema),
  ]);
  return { ...profileSchema, remoteLanguages, remoteCfs };
}

// How the custom formats a profile references map to this instance's ids.
interface CfMapping {
  // trash_id → the live remote id.
  appliedByTrashId: Map<string, number>;
  // Every referenced spec that exists, for its scores.
  specByTrashId: Map<string, TrashSpec>;
  // Specs with no live CF on the instance that an enabled (or absent)
  // application lets the profile apply first.
  toCascade: TrashSpec[];
}

// Resolves referenced CFs to remoteIds for THIS instance. Each Radarr/Sonarr instance assigns
// its own customformat ids, so a profile must map against that instance's applications — mixing in
// another instance's remoteIds would point the profile at the wrong (or non-existent) CFs.
// The live CF list comes BEFORE any stored remoteId is trusted. An arr reset or
// a CF deleted and recreated outside Summonarr leaves a stored id naming
// nothing, or an unrelated CF: scoring by it would give the real CF 0 and the
// unrelated one this CF's score. resolveRemoteId re-checks each id by name; an
// id the live list doesn't carry counts as unapplied and joins the cascade.
// A DISABLED application is the admin's "stop managing this": its live CF is
// still scored, but a profile never pushes it.
async function resolveCfMapping(
  service: TrashService,
  arrInstance: string,
  referenced: ReadonlySet<string>,
  remoteCfs: readonly RemoteCf[],
): Promise<CfMapping> {
  const mapping: CfMapping = { appliedByTrashId: new Map(), specByTrashId: new Map(), toCascade: [] };
  if (referenced.size === 0) return mapping;
  const live = indexRemote(remoteCfs);
  const applications = await prisma.trashApplication.findMany({
    where: {
      arrInstance,
      trashSpec: { service, kind: "CUSTOM_FORMAT", trashId: { in: [...referenced] } },
    },
    include: { trashSpec: true },
  });
  // trash_ids an application already decides: applied live, stale, or disabled.
  const decided = new Set<string>();
  for (const a of applications) {
    const trashId = a.trashSpec.trashId;
    mapping.specByTrashId.set(trashId, a.trashSpec);
    const liveId = a.remoteId == null ? null : resolveRemoteId(a.remoteId, a.trashSpec.name, live.nameById, live.idByName);
    if (liveId != null && live.nameById.has(liveId)) {
      mapping.appliedByTrashId.set(trashId, liveId);
      decided.add(trashId);
    } else if (!a.enabled) {
      decided.add(trashId);
    } else if (a.remoteId != null) {
      mapping.toCascade.push(a.trashSpec);
      decided.add(trashId);
    }
  }
  // Every referenced CF spec that exists is now in memory: a referenced trashId
  // either rode along on the application read above or is read here. The
  // cascade writes TrashApplication rows and the arr, never TrashSpec.payload,
  // so these rows stay current for the scores.
  const undecided = [...referenced].filter((id) => !decided.has(id));
  if (undecided.length > 0) {
    const missing = await prisma.trashSpec.findMany({
      where: { service, kind: "CUSTOM_FORMAT", trashId: { in: undecided } },
    });
    for (const s of missing) {
      mapping.specByTrashId.set(s.trashId, s);
      mapping.toCascade.push(s);
    }
  }
  return mapping;
}

// Applies the CFs the profile needs but the instance lacks; true when any landed.
async function cascadeMissingCfs(
  service: TrashService,
  variant: ArrVariant,
  mapping: CfMapping,
  opts: ApplyOptions,
): Promise<boolean> {
  if (mapping.toCascade.length === 0) return false;
  const results = await applyCustomFormats(service, mapping.toCascade.map((s) => s.id), variant, opts);
  let applied = false;
  for (const r of results) {
    if (r.ok && r.remoteId != null) {
      mapping.appliedByTrashId.set(r.trashId, r.remoteId);
      applied = true;
    }
  }
  return applied;
}

// Some CFs in Arr embed a trash_id field in their spec metadata — use it to map remote CFs we didn't apply ourselves
function mapEmbeddedTrashIds(remoteCfs: readonly RemoteCf[], appliedByTrashId: Map<string, number>): void {
  for (const cf of remoteCfs) {
    if (!Array.isArray(cf.specifications)) continue;
    for (const spec of cf.specifications) {
      if (!isRecord(spec) || !Array.isArray(spec.fields)) continue;
      for (const field of spec.fields) {
        if (isRecord(field) && field.name === "trash_id" && typeof field.value === "string" && !appliedByTrashId.has(field.value)) {
          appliedByTrashId.set(field.value, cf.id);
        }
      }
    }
  }
}

function ownScore(scores: Record<string, number> | undefined, key: string): number | undefined {
  return scores && Object.hasOwn(scores, key) ? scores[key] : undefined;
}

// A CF's TRaSH score for the profile's score set, else its default, else 0.
function cfScore(spec: TrashSpec | undefined, scoreSet: string): number {
  const scores = spec ? storedPayload(spec, isCustomFormatPayload)?.trash_scores : undefined;
  return ownScore(scores, scoreSet) ?? ownScore(scores, "default") ?? 0;
}

// One formatItems entry per remote CF (the arr reads a missing one as unset).
// One reverse index, built once the mapping is final, so each remote CF is a
// single lookup however many the arr sends (guardrail 5i). The first trash_id
// mapped to a remote id keeps it: stored applications, then the cascade, then
// trash_id fields.
function buildFormatItems(
  remoteCfs: readonly RemoteCf[],
  appliedByTrashId: Map<string, number>,
  scoreByTrashId: Map<string, number>,
): RemoteFormatItem[] {
  const trashIdByRemoteId = new Map<number, string>();
  for (const [tid, rid] of appliedByTrashId) {
    if (!trashIdByRemoteId.has(rid)) trashIdByRemoteId.set(rid, tid);
  }
  return remoteCfs.map((cf) => {
    const trashId = trashIdByRemoteId.get(cf.id);
    const score = trashId ? scoreByTrashId.get(trashId) ?? 0 : 0;
    return { format: cf.id, name: cf.name, score };
  });
}

// Fallback ids (used only when GET /api/v3/language failed) must match
// Radarr's Language.cs pseudo-languages: Any = -1, Original = -2. Radarr
// stores and compares the id, not the name, so swapping them would silently
// save the OPPOSITE setting ("Any" turns the language filter off entirely).
export function resolveLanguage(wanted: string | null | undefined, remoteLanguages: readonly Language[]): Language | undefined {
  const want = (wanted ?? "").toLowerCase();
  const byName = (name: string) => remoteLanguages.find((l) => l.name.toLowerCase() === name);
  if (want === "original" || want === "") return byName("original") ?? { id: -2, name: "Original" };
  if (want === "any") return byName("any") ?? { id: -1, name: "Any" };
  return byName(want);
}

// The profile body: the arr's schema with TRaSH's values over it. The schema's
// own `id` is dropped so it never names the write's target.
function assembleProfileBody(
  schema: Record<string, unknown>,
  profile: TrashQualityProfile,
  parts: { items: ProfileQualityItem[]; cutoff: number | undefined; formatItems: RemoteFormatItem[]; language: Language | undefined },
): Record<string, unknown> {
  const body: Record<string, unknown> = { ...schema };
  delete body.id;
  body.name = profile.name;
  body.upgradeAllowed = profile.upgradeAllowed ?? true;
  body.minFormatScore = profile.minFormatScore ?? 0;
  body.cutoffFormatScore = profile.cutoffFormatScore ?? 0;
  if (profile.minUpgradeFormatScore != null) body.minUpgradeFormatScore = profile.minUpgradeFormatScore;
  body.items = parts.items;
  body.formatItems = parts.formatItems;
  if (parts.cutoff != null) body.cutoff = parts.cutoff;
  if (parts.language) body.language = parts.language;
  return body;
}

async function buildProfileBody(
  cfg: ArrCfg,
  service: TrashService,
  profile: TrashQualityProfile,
  variant: ArrVariant,
  remotes: ProfileBuildRemotes,
  opts: ApplyOptions,
): Promise<Record<string, unknown>> {
  const referenced = new Set<string>(Object.values(profile.formatItems ?? {}));
  const mapping = await resolveCfMapping(service, toArrInstance(variant), referenced, remotes.remoteCfs);
  // The CF list read above is valid only while the dependency cascade created
  // nothing — a cascade-created CF must land in formatItems, so refetch in that
  // case. The refetch goes back into the shared batch state too: the cascade
  // CREATED custom formats upstream and the DB now records them as applied, so
  // the NEXT profile in the batch computes no cascade and takes the shared
  // list — which without the write-back is the pre-cascade snapshot missing
  // those very CFs. Their formatItems entries would be absent and
  // Radarr/Sonarr would read the scores as unset, silently dropping TRaSH's
  // (often large negative) scores for every profile after the first cascade.
  if (await cascadeMissingCfs(service, variant, mapping, opts) && !opts.signal?.aborted) {
    remotes.remoteCfs = await arrRead(cfg, "/api/v3/customformat", RemoteCfListSchema);
  }
  mapEmbeddedTrashIds(remotes.remoteCfs, mapping.appliedByTrashId);

  const { items, idByName } = buildProfileItems(remotes.schemaItems, profile.items ?? []);
  const scoreSet = profile.score_set ?? "default";
  const scoreByTrashId = new Map<string, number>();
  for (const trashId of referenced) scoreByTrashId.set(trashId, cfScore(mapping.specByTrashId.get(trashId), scoreSet));
  return assembleProfileBody(remotes.schema, profile, {
    items,
    cutoff: idByName.get(profile.cutoff ?? ""),
    formatItems: buildFormatItems(remotes.remoteCfs, mapping.appliedByTrashId, scoreByTrashId),
    language: resolveLanguage(profile.language, remotes.remoteLanguages),
  });
}

type ProfileSpec = TrashSpec & { applications: Array<{ remoteId: number | null }> };

// One profile's apply; null when the lock's signal stopped it before the write.
async function applyOneProfile(
  cfg: ArrCfg,
  service: TrashService,
  variant: ArrVariant,
  spec: ProfileSpec,
  remoteProfiles: ReturnType<typeof indexRemote>,
  shared: ProfileBuildRemotes | undefined,
  opts: ApplyOptions,
): Promise<ApplyOutcome | null> {
  const profile = storedPayload(spec, isQualityProfilePayload);
  if (!profile) return { ok: false, error: STORED_PAYLOAD_INVALID };
  try {
    const remotes = shared ?? await readProfileRemotes(cfg);
    const body = await buildProfileBody(cfg, service, profile, variant, remotes, opts);
    // Never write a profile whose custom-format cascade was cut short.
    if (opts.signal?.aborted) return null;
    const remoteId = resolveRemoteId(spec.applications[0]?.remoteId, profile.name, remoteProfiles.nameById, remoteProfiles.idByName);
    return { ok: true, ...(await upsertRemote(cfg, "/api/v3/qualityprofile", remoteId, body)) };
  } catch (err) {
    return { ok: false, error: formatArrError(err) };
  }
}

// Builds each QUALITY_PROFILE body (resolving CF remoteIds + scores for the variant) and PUT/POSTs it to the instance.
export async function applyQualityProfiles(
  service: TrashService,
  specIds: string[],
  variant: ArrVariant = "hd",
  opts: ApplyOptions = {},
): Promise<ApplyResult[]> {
  const arrInstance = toArrInstance(variant);
  const cfg = await resolveCfg(service, variant);
  const specs = await prisma.trashSpec.findMany({
    where: { id: { in: specIds }, service, kind: "QUALITY_PROFILE" },
    include: { applications: { where: { arrInstance } } },
  });
  if (specs.length === 0) return [];

  let remoteProfiles: ReturnType<typeof indexRemote>;
  try {
    remoteProfiles = indexRemote(await arrRead(cfg, "/api/v3/qualityprofile", NamedIdListSchema));
  } catch (err) {
    // Can't read existing quality profiles → a blind POST below would duplicate
    // them. Fail the whole batch instead of guessing, and log a warning.
    console.warn("[trash] failed to prefetch remote qualityprofile list:", err instanceof Error ? err.message : err);
    return recordAllFailed(specs, "Could not read existing quality profiles from the *arr instance", arrInstance);
  }

  // Read once per batch (AFTER the prefetch guard above, so the
  // prefetch-failure early return never pays these): schema, languages and the
  // CF list are instance-level state identical for every profile spec.
  // Best-effort — on failure each spec reads its own, and records its own error.
  const shared = await readProfileRemotes(cfg).catch(() => undefined);

  const entries: Array<{ spec: ProfileSpec; outcome: ApplyOutcome }> = [];
  for (const spec of specs) {
    if (opts.signal?.aborted) break;
    const outcome = await applyOneProfile(cfg, service, variant, spec, remoteProfiles, shared, opts);
    if (outcome === null) break;
    entries.push({ spec, outcome });
  }
  return recordApplies(entries, arrInstance);
}
