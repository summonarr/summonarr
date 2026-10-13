// Library match check — the I/O half (rules in library-match.ts).
//
// Reads every configured Plex/Jellyfin server's whole movie and show listing —
// every copy and every unmatched item, live, not the sync's stored one row per
// TMDB id — and every configured Radarr/Sonarr instance's titles with their
// folders, judges them, and keeps the answer in one Setting row so the library
// page paints it at once. Read-only towards every server. Run on demand
// (POST /api/admin/library/match-check), never on a schedule.
//
// A source that can't be read is named in the report and contributes nothing:
// its items are not judged (a down media server), or its folders referee
// nothing (a down Radarr/Sonarr — never a wrongMatch on an item it would have
// agreed with).
import { Prisma } from "@/generated/prisma";
import { prisma } from "@/lib/prisma";
import { isFeatureEnabled } from "@/lib/features";
import { getSyncableMediaInstances } from "@/lib/media-instance-registry";
import { jellyfinSettingKey, plexSettingKey } from "@/lib/media-instances";
import { getPlexConfig } from "@/lib/plex-config";
import { getJellyfinConfig } from "@/lib/jellyfin-config";
import { listPlexMatchEntries } from "@/lib/plex";
import { listJellyfinMatchEntries } from "@/lib/jellyfin";
import { getSyncableArrInstances } from "@/lib/arr-instance-registry";
import { arrErrorKind, arrFetch, getArrCfg, resolveTvdbToTmdb } from "@/lib/arr";
import type { ArrErrorKind } from "@/lib/arr-error-kind";
import {
  judgeLibraryMatches,
  type ArrMatchEntry,
  type MatchCounts,
  type MatchFlag,
  type ServerMatchEntry,
} from "@/lib/library-match";

export const LIBRARY_MATCH_REPORT_KEY = "libraryMatchCheck:report";
// Serializes every write of the report row: the check storing a new report and
// a fix dropping its flag (fix-match's item mode). The two-key form, so it
// never meets the single-key session lock LIBRARY_MATCH_CHECK_LOCK_ID the
// check's walk holds for minutes.
const REPORT_ROW_LOCK = Prisma.sql`SELECT pg_advisory_xact_lock(2071, 1)`;
// The page renders every flag; a server where most of the library is wrong is
// a configuration problem the first few hundred rows already show.
export const MAX_STORED_FLAGS = 2_000;

export type LibraryMatchSourceService = "plex" | "jellyfin" | "radarr" | "sonarr";

export interface LibraryMatchSource {
  service: LibraryMatchSourceService;
  instance: string;
  ok: boolean;
  /** Radarr/Sonarr only: why it couldn't be read (translated by the page). */
  kind?: ArrErrorKind;
  /** Items (servers) or titles (Radarr/Sonarr) read. */
  items: number;
}

export interface LibraryMatchReport {
  version: 1;
  checkedAt: string;
  sources: LibraryMatchSource[];
  counts: MatchCounts;
  flags: MatchFlag[];
  /** Flags past MAX_STORED_FLAGS, not stored. */
  truncated: number;
}

function parseSelection(value: string | undefined): Set<string> | undefined {
  if (!value) return undefined;
  const keys = new Set(value.split(",").map((k) => k.trim()).filter(Boolean));
  return keys.size ? keys : undefined;
}

const positiveInt = (v: unknown): number | null =>
  typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null;
const imdb = (v: unknown): string | null =>
  typeof v === "string" && /^tt\d+$/.test(v) ? v : null;
const text = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

type ArrRow = { tmdbId?: unknown; tvdbId?: unknown; imdbId?: unknown; title?: unknown; year?: unknown; path?: unknown };

/** Radarr/Sonarr rows → ArrMatchEntry, keeping only rows with a folder. Exported for tests. */
export function projectArrRows(service: "radarr" | "sonarr", instance: string, rows: unknown): ArrMatchEntry[] {
  if (!Array.isArray(rows)) return [];
  const out: ArrMatchEntry[] = [];
  for (const raw of rows as ArrRow[]) {
    if (!raw || typeof raw !== "object") continue;
    const path = text(raw.path);
    if (!path) continue;
    out.push({
      service,
      instance,
      mediaType: service === "radarr" ? "MOVIE" : "TV",
      tmdbId: positiveInt(raw.tmdbId),
      tvdbId: service === "sonarr" ? positiveInt(raw.tvdbId) : null,
      imdbId: imdb(raw.imdbId),
      title: text(raw.title),
      year: positiveInt(raw.year),
      path,
    });
  }
  return out;
}

async function readMediaServers(sources: LibraryMatchSource[], signal?: AbortSignal): Promise<ServerMatchEntry[]> {
  const [plexOn, jellyfinOn] = await Promise.all([
    isFeatureEnabled("feature.integration.plex"),
    isFeatureEnabled("feature.integration.jellyfin"),
  ]);
  const [plexInstances, jellyfinInstances] = await Promise.all([
    plexOn ? getSyncableMediaInstances("plex") : Promise.resolve([]),
    jellyfinOn ? getSyncableMediaInstances("jellyfin") : Promise.resolve([]),
  ]);
  // Each server's own library selection, exactly as the sync reads it.
  const selectionKeys = [
    ...plexInstances.map((i) => plexSettingKey(i.slug, "Libraries")),
    ...jellyfinInstances.map((i) => jellyfinSettingKey(i.slug, "Libraries")),
  ];
  const selectionRows = selectionKeys.length
    ? await prisma.setting.findMany({ where: { key: { in: selectionKeys } }, select: { key: true, value: true } })
    : [];
  const selection = new Map(selectionRows.map((r) => [r.key, parseSelection(r.value)]));

  const entries: ServerMatchEntry[] = [];
  for (const instance of plexInstances) {
    if (signal?.aborted) break;
    try {
      const cfg = await getPlexConfig(instance.slug);
      if (!cfg.url || !cfg.token) continue;
      const url = cfg.url.replace(/\/$/, "");
      const selected = selection.get(plexSettingKey(instance.slug, "Libraries"));
      const items = [
        ...await listPlexMatchEntries(url, cfg.token, instance.slug, "MOVIE", selected),
        ...await listPlexMatchEntries(url, cfg.token, instance.slug, "TV", selected),
      ];
      entries.push(...items);
      sources.push({ service: "plex", instance: instance.slug, ok: true, items: items.length });
    } catch (err) {
      console.warn(`[library-match] Plex "${instance.slug}" could not be listed:`, err instanceof Error ? err.message : err);
      sources.push({ service: "plex", instance: instance.slug, ok: false, items: 0 });
    }
  }
  for (const instance of jellyfinInstances) {
    if (signal?.aborted) break;
    try {
      const cfg = await getJellyfinConfig(instance.slug);
      if (!cfg.url || !cfg.apiKey) continue;
      const selected = selection.get(jellyfinSettingKey(instance.slug, "Libraries"));
      const items = [
        ...await listJellyfinMatchEntries(cfg.url, cfg.apiKey, instance.slug, "MOVIE", selected),
        ...await listJellyfinMatchEntries(cfg.url, cfg.apiKey, instance.slug, "TV", selected),
      ];
      entries.push(...items);
      sources.push({ service: "jellyfin", instance: instance.slug, ok: true, items: items.length });
    } catch (err) {
      console.warn(`[library-match] Jellyfin "${instance.slug}" could not be listed:`, err instanceof Error ? err.message : err);
      sources.push({ service: "jellyfin", instance: instance.slug, ok: false, items: 0 });
    }
  }
  return entries;
}

async function readArrs(sources: LibraryMatchSource[], signal?: AbortSignal): Promise<ArrMatchEntry[]> {
  const out: ArrMatchEntry[] = [];
  const enabled = { radarr: await isFeatureEnabled("feature.integration.radarr"), sonarr: await isFeatureEnabled("feature.integration.sonarr") };
  for (const service of ["radarr", "sonarr"] as const) {
    if (!enabled[service]) continue;
    for (const instance of await getSyncableArrInstances(service)) {
      if (signal?.aborted) break;
      try {
        const cfg = await getArrCfg(service, instance.slug);
        if (!cfg) continue;
        const rows = projectArrRows(service, instance.slug, await arrFetch<unknown>(cfg, service === "radarr" ? "/api/v3/movie" : "/api/v3/series"));
        out.push(...rows);
        sources.push({ service, instance: instance.slug, ok: true, items: rows.length });
      } catch (err) {
        sources.push({ service, instance: instance.slug, ok: false, kind: arrErrorKind(err), items: 0 });
      }
    }
  }
  return out;
}

/**
 * Run the check and store its report. Returns null when `signal` aborted part
 * way (guardrail 41) — nothing is stored then, and the previous report stays.
 */
export async function runLibraryMatchCheck(opts: { signal?: AbortSignal; now?: Date } = {}): Promise<LibraryMatchReport | null> {
  const sources: LibraryMatchSource[] = [];
  const [entries, arr] = await Promise.all([readMediaServers(sources, opts.signal), readArrs(sources, opts.signal)]);
  if (opts.signal?.aborted) return null;

  const { flags, counts } = judgeLibraryMatches(entries, arr);
  // Sonarr v3 carries no TMDB id: a flag's suggestion comes from TMDB's own
  // TVDB cross-reference, the mapping the sync's Sonarr cache uses. Only the
  // flagged series are resolved.
  const unresolved = [...new Set(flags.flatMap((f) => (f.arr && f.arr.tmdbId === null && f.arr.tvdbId !== null ? [f.arr.tvdbId] : [])))];
  if (unresolved.length > 0) {
    const { map } = await resolveTvdbToTmdb(unresolved).catch(() => ({ map: new Map<number, number>() }));
    for (const f of flags) {
      if (f.arr && f.arr.tmdbId === null && f.arr.tvdbId !== null) f.arr.tmdbId = map.get(f.arr.tvdbId) ?? null;
    }
  }
  if (opts.signal?.aborted) return null;

  const report: LibraryMatchReport = {
    version: 1,
    checkedAt: (opts.now ?? new Date()).toISOString(),
    sources: sources.sort((a, b) => a.service.localeCompare(b.service) || a.instance.localeCompare(b.instance)),
    counts,
    flags: flags.slice(0, MAX_STORED_FLAGS),
    truncated: Math.max(0, flags.length - MAX_STORED_FLAGS),
  };
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw(REPORT_ROW_LOCK);
    const value = JSON.stringify(report);
    await tx.setting.upsert({
      where: { key: LIBRARY_MATCH_REPORT_KEY },
      create: { key: LIBRARY_MATCH_REPORT_KEY, value },
      update: { value },
    });
  });
  return report;
}

/** The stored report, or null when none was stored (or it is from another version). Exported for tests. */
export function parseLibraryMatchReport(value: string | null | undefined): LibraryMatchReport | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<LibraryMatchReport>;
    if (parsed.version !== 1 || !Array.isArray(parsed.flags) || !Array.isArray(parsed.sources) || !parsed.counts || typeof parsed.checkedAt !== "string") return null;
    return parsed as LibraryMatchReport;
  } catch {
    return null;
  }
}

export async function readLibraryMatchReport(): Promise<LibraryMatchReport | null> {
  const row = await prisma.setting.findUnique({ where: { key: LIBRARY_MATCH_REPORT_KEY } });
  return parseLibraryMatchReport(row?.value);
}

/** The stored flag for one server item, if the last check reported it. */
export function findMatchFlag(
  report: LibraryMatchReport | null,
  server: "plex" | "jellyfin",
  serverInstance: string,
  itemKey: string,
): MatchFlag | null {
  return report?.flags.find((f) => f.server === server && f.serverInstance === serverInstance && f.itemKey === itemKey) ?? null;
}

// The interactive-tx client of the EXTENDED prisma (the generated
// Prisma.TransactionClient is not assignable to it — see account-lifecycle.ts).
type TxClient = Omit<typeof prisma, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">;
type ReportTx = Pick<TxClient, "$executeRaw" | "setting">;

/** Remove one item's flag from the stored report — the fix that resolved it, inside its transaction. */
export async function dropMatchFlagInTx(tx: ReportTx, server: "plex" | "jellyfin", serverInstance: string, itemKey: string): Promise<void> {
  await tx.$executeRaw(REPORT_ROW_LOCK);
  const row = await tx.setting.findUnique({ where: { key: LIBRARY_MATCH_REPORT_KEY } });
  const report = parseLibraryMatchReport(row?.value);
  if (!report) return;
  const flags = report.flags.filter((f) => !(f.server === server && f.serverInstance === serverInstance && f.itemKey === itemKey));
  if (flags.length === report.flags.length) return;
  const next: LibraryMatchReport = { ...report, flags, counts: { ...report.counts, flagged: report.counts.flagged - 1 } };
  await tx.setting.update({ where: { key: LIBRARY_MATCH_REPORT_KEY }, data: { value: JSON.stringify(next) } });
}

type MoveTx = Pick<TxClient, "plexLibraryItem" | "jellyfinLibraryItem">;

const keysOf = (canonical: string | null, all: string[]): string[] =>
  Array.from(new Set([...(canonical ? [canonical] : []), ...all]));

/**
 * A remapped server item's library rows (fix-match item mode), until the next
 * full sync rewrites them from the server: the item leaves every OTHER title's
 * row on its server — a row left with no copy is deleted, a row whose canonical
 * copy it was falls back to its next copy (path unknown until the sync) — and
 * joins the corrected title's row, created when the server held no copy of it.
 * Only `oldKey`/`newKey` move: the other copies of the old title stay exactly
 * where they were, which is the whole point of fixing one item (guardrail 37's
 * every-copy remap would have rematched a correctly matched copy too).
 */
export async function moveItemToTitleInTx(
  tx: MoveTx,
  server: "plex" | "jellyfin",
  serverInstance: string,
  mediaType: "MOVIE" | "TV",
  oldKey: string,
  newKey: string,
  correctTmdbId: number,
  filePath: string | null,
): Promise<void> {
  const moved = new Set([oldKey, newKey]);
  const targetWhere = { tmdbId_mediaType_serverInstance: { tmdbId: correctTmdbId, mediaType, serverInstance } };
  if (server === "plex") {
    const holders = await tx.plexLibraryItem.findMany({
      where: { serverInstance, mediaType, tmdbId: { not: correctTmdbId }, OR: [{ plexRatingKey: { in: [...moved] } }, { plexRatingKeys: { hasSome: [...moved] } }] },
      select: { tmdbId: true, plexRatingKey: true, plexRatingKeys: true },
    });
    for (const h of holders) {
      const rest = keysOf(h.plexRatingKey, h.plexRatingKeys).filter((k) => !moved.has(k));
      const where = { tmdbId_mediaType_serverInstance: { tmdbId: h.tmdbId, mediaType, serverInstance } };
      if (rest.length === 0) await tx.plexLibraryItem.deleteMany({ where: { tmdbId: h.tmdbId, mediaType, serverInstance } });
      else if (h.plexRatingKey !== null && moved.has(h.plexRatingKey)) await tx.plexLibraryItem.update({ where, data: { plexRatingKey: rest[0], plexRatingKeys: rest, filePath: null } });
      else await tx.plexLibraryItem.update({ where, data: { plexRatingKeys: rest } });
    }
    const target = await tx.plexLibraryItem.findUnique({ where: targetWhere, select: { plexRatingKey: true, plexRatingKeys: true } });
    if (!target) {
      await tx.plexLibraryItem.create({ data: { tmdbId: correctTmdbId, mediaType, serverInstance, plexRatingKey: newKey, plexRatingKeys: [newKey], filePath } });
    } else {
      await tx.plexLibraryItem.update({
        where: targetWhere,
        data: { plexRatingKey: target.plexRatingKey ?? newKey, plexRatingKeys: keysOf(target.plexRatingKey ?? newKey, [...target.plexRatingKeys, newKey]) },
      });
    }
    return;
  }
  const holders = await tx.jellyfinLibraryItem.findMany({
    where: { serverInstance, mediaType, tmdbId: { not: correctTmdbId }, OR: [{ jellyfinItemId: { in: [...moved] } }, { jellyfinItemIds: { hasSome: [...moved] } }] },
    select: { tmdbId: true, jellyfinItemId: true, jellyfinItemIds: true },
  });
  for (const h of holders) {
    const rest = keysOf(h.jellyfinItemId, h.jellyfinItemIds).filter((k) => !moved.has(k));
    const where = { tmdbId_mediaType_serverInstance: { tmdbId: h.tmdbId, mediaType, serverInstance } };
    if (rest.length === 0) await tx.jellyfinLibraryItem.deleteMany({ where: { tmdbId: h.tmdbId, mediaType, serverInstance } });
    else if (h.jellyfinItemId !== null && moved.has(h.jellyfinItemId)) await tx.jellyfinLibraryItem.update({ where, data: { jellyfinItemId: rest[0], jellyfinItemIds: rest, filePath: null } });
    else await tx.jellyfinLibraryItem.update({ where, data: { jellyfinItemIds: rest } });
  }
  const target = await tx.jellyfinLibraryItem.findUnique({ where: targetWhere, select: { jellyfinItemId: true, jellyfinItemIds: true } });
  if (!target) {
    await tx.jellyfinLibraryItem.create({ data: { tmdbId: correctTmdbId, mediaType, serverInstance, jellyfinItemId: newKey, jellyfinItemIds: [newKey], filePath } });
  } else {
    await tx.jellyfinLibraryItem.update({
      where: targetWhere,
      data: { jellyfinItemId: target.jellyfinItemId ?? newKey, jellyfinItemIds: keysOf(target.jellyfinItemId ?? newKey, [...target.jellyfinItemIds, newKey]) },
    });
  }
}
