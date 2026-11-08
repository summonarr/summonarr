// Naming and quality sizes → Radarr/Sonarr: both merge the TRaSH values into
// the instance's whole config and PUT it back once per batch.
import { prisma } from "./prisma";
import { arrFetch, type ArrCfg, type ArrVariant } from "./arr";
import { v } from "./validate";
import {
  arrRead,
  arrReadWhole,
  formatArrError,
  recordApplies,
  resolveCfg,
  STORED_PAYLOAD_INVALID,
  storedPayload,
  toArrInstance,
  type ApplyOutcome,
} from "./trash-apply-common";
import { isNamingPayload, isQualitySizePayload } from "./trash-validators";
import type { ApplyResult, TrashQualitySize } from "./trash-types";
import type { TrashService } from "@/generated/prisma";

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

// Every key the arr sent: the PUT must carry all of them.
const NamingConfigSchema = v.record(v.unknown());

// One write shared by a whole batch: ok, or the error every spec in it records.
async function settleWrite(write: () => Promise<void>): Promise<ApplyOutcome> {
  try {
    await write();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: formatArrError(err) };
  }
}

// The outcome of each spec: its batch's shared one, unless its stored payload
// failed its validator and it took no part.
function outcomesFor<S>(
  specs: readonly S[],
  payloads: readonly unknown[],
  shared: ApplyOutcome,
): Array<{ spec: S; outcome: ApplyOutcome }> {
  return specs.map((spec, i) => ({
    spec,
    outcome: payloads[i] !== null ? shared : { ok: false, error: STORED_PAYLOAD_INVALID },
  }));
}

async function writeNaming(cfg: ArrCfg, service: TrashService, payloads: ReadonlyArray<Record<string, unknown> | null>): Promise<void> {
  // Fetch the full naming config first; Radarr/Sonarr require all fields on PUT, not just the changed ones
  const current = await arrRead(cfg, "/api/v3/config/naming", NamingConfigSchema);
  const merged: Record<string, unknown> = { ...current };
  for (const payload of payloads) {
    if (payload) Object.assign(merged, buildNamingPatch(service, payload));
  }
  // No-op skip: `merged` spreads `current` first, so when every patch value
  // already matches the remote config the two serialize identically — record
  // success without the PUT (the cron re-applies every run for drift repair).
  if (JSON.stringify(merged) === JSON.stringify(current)) return;
  await arrFetch<unknown>(cfg, `/api/v3/config/naming`, {
    method: "PUT",
    body: JSON.stringify(merged),
  });
}

// Merges NAMING specs into the instance's full /config/naming (Arr requires all fields on PUT) and writes it back.
export async function applyNaming(
  service: TrashService,
  specIds: string[],
  variant: ArrVariant = "hd",
): Promise<ApplyResult[]> {
  const arrInstance = toArrInstance(variant);
  const cfg = await resolveCfg(service, variant);
  const specs = await prisma.trashSpec.findMany({
    where: { id: { in: specIds }, service, kind: "NAMING" },
  });
  if (specs.length === 0) return [];
  const payloads = specs.map((s) => storedPayload(s, isNamingPayload));
  const shared = payloads.some((p) => p !== null)
    ? await settleWrite(() => writeNaming(cfg, service, payloads))
    : { ok: true as const };
  return recordApplies(outcomesFor(specs, payloads, shared), arrInstance);
}

// Orders QUALITY_SIZE specs for the merge: by name, then trash_id, so the spec
// that wins a quality two of them set never depends on database row order.
function compareSizeSpecs(a: { name: string; trashId: string }, b: { name: string; trashId: string }): number {
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  if (a.trashId !== b.trashId) return a.trashId < b.trashId ? -1 : 1;
  return 0;
}

type SizeOverride = { min: number; preferred?: number; max: number };

// Multiple specs may reference the same quality name; the last writer in
// compareSizeSpecs order wins. `owner` remembers which spec (by index) that was.
function mergeSizeOverrides(payloads: ReadonlyArray<TrashQualitySize | null>) {
  const combined = new Map<string, SizeOverride>();
  const owner = new Map<string, number>();
  payloads.forEach((payload, i) => {
    for (const q of payload?.qualities ?? []) {
      combined.set(q.quality, { min: q.min, preferred: q.preferred, max: q.max });
      owner.set(q.quality, i);
    }
  });
  return { combined, owner };
}

// The later specs that set every quality spec `i` sets, so none of its values
// were sent; undefined when it still owns one (or sets none).
function supersededBy(
  i: number,
  payloads: ReadonlyArray<TrashQualitySize | null>,
  owner: Map<string, number>,
  names: readonly string[],
): string[] | undefined {
  const qualities = payloads[i]?.qualities ?? [];
  if (qualities.length === 0) return undefined;
  const winners = new Set<number>();
  for (const q of qualities) {
    const w = owner.get(q.quality);
    if (w === undefined || w === i) return undefined;
    winners.add(w);
  }
  return [...winners].sort((a, b) => a - b).map((w) => names[w]);
}

// The rows the merge reads. Each is sent back whole, every field the arr sent kept.
const QualityDefinitionsSchema = v.array(v.object({ quality: v.object({ name: v.string() }) }));

async function writeSizeOverrides(cfg: ArrCfg, combined: Map<string, SizeOverride>): Promise<void> {
  const rows = await arrReadWhole(cfg, "/api/v3/qualitydefinition", QualityDefinitionsSchema);
  const merged = rows.map((row) => {
    const over = combined.get(row.quality.name);
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
  const changed = merged.some((row, i) => row !== rows[i] && JSON.stringify(row) !== JSON.stringify(rows[i]));
  if (!changed) return;
  await arrFetch<unknown>(cfg, "/api/v3/qualitydefinition/update", {
    method: "PUT",
    body: JSON.stringify(merged),
  });
}

// Overrides the instance's quality-definition min/preferred/max sizes with the given QUALITY_SIZE specs (last writer wins per quality name, in compareSizeSpecs order).
export async function applyQualitySizes(
  service: TrashService,
  specIds: string[],
  variant: ArrVariant = "hd",
): Promise<ApplyResult[]> {
  const arrInstance = toArrInstance(variant);
  const cfg = await resolveCfg(service, variant);
  const specs = (await prisma.trashSpec.findMany({
    where: { id: { in: specIds }, service, kind: "QUALITY_SIZE" },
  })).sort(compareSizeSpecs);
  if (specs.length === 0) return [];
  const payloads = specs.map((s) => storedPayload(s, isQualitySizePayload));
  const { combined, owner } = mergeSizeOverrides(payloads);
  const shared = payloads.some((p) => p !== null)
    ? await settleWrite(() => writeSizeOverrides(cfg, combined))
    : { ok: true as const };

  const names = specs.map((s) => s.name);
  const results = await recordApplies(outcomesFor(specs, payloads, shared), arrInstance);
  return results.map((result, i) => {
    const by = result.ok ? supersededBy(i, payloads, owner, names) : undefined;
    return by ? { ...result, supersededBy: by } : result;
  });
}
