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
import { prisma, type PrismaTxClient } from "@/lib/prisma";
import { isFeatureEnabled } from "@/lib/features";
import { getSyncableMediaInstances } from "@/lib/media-instance-registry";
import { jellyfinSettingKey, plexSettingKey } from "@/lib/media-instances";
import { getPlexConfig } from "@/lib/plex-config";
import { getJellyfinConfig } from "@/lib/jellyfin-config";
import { listPlexMatchEntries } from "@/lib/plex";
import { listJellyfinMatchEntries } from "@/lib/jellyfin";
import { getSyncableArrInstances } from "@/lib/arr-instance-registry";
import { arrErrorKind, arrFetch, getArrCfg, resolveTvdbToTmdb } from "@/lib/arr";
import { parseLibrarySelection } from "@/lib/library-resync";
import { sanitizeForLog } from "@/lib/sanitize";
import type { ArrErrorKind } from "@/lib/arr-error-kind";
import {
  judgeLibraryMatches,
  type ArrMatchEntry,
  type MatchCounts,
  type MatchFlag,
  type MatchServer,
  type ServerMatchEntry,
} from "@/lib/library-match";
import { check, v } from "@/lib/validate";

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

type ServerSelection = Set<string> | undefined;

/**
 * One server's movie and show listing, or null when it isn't configured. The
 * signal reaches the Plex walk, so an abort stops it mid-listing (it rejects,
 * and the caller takes the source-failed path).
 */
async function listServerInstance(
  server: MatchServer, slug: string, selected: ServerSelection, signal?: AbortSignal,
): Promise<ServerMatchEntry[] | null> {
  if (server === "plex") {
    const cfg = await getPlexConfig(slug);
    if (!cfg.url || !cfg.token) return null;
    const url = cfg.url.replace(/\/$/, "");
    const movies = await listPlexMatchEntries(url, cfg.token, slug, "MOVIE", selected, { signal });
    return movies.concat(await listPlexMatchEntries(url, cfg.token, slug, "TV", selected, { signal }));
  }
  const cfg = await getJellyfinConfig(slug);
  if (!cfg.url || !cfg.apiKey) return null;
  const movies = await listJellyfinMatchEntries(cfg.url, cfg.apiKey, slug, "MOVIE", selected);
  return movies.concat(await listJellyfinMatchEntries(cfg.url, cfg.apiKey, slug, "TV", selected));
}

const SERVER_LABEL: Record<MatchServer, string> = { plex: "Plex", jellyfin: "Jellyfin" };
const selectionKeyOf = (server: MatchServer, slug: string) =>
  server === "plex" ? plexSettingKey(slug, "Libraries") : jellyfinSettingKey(slug, "Libraries");

async function readMediaServers(sources: LibraryMatchSource[], signal?: AbortSignal): Promise<ServerMatchEntry[]> {
  const [plexOn, jellyfinOn] = await Promise.all([
    isFeatureEnabled("feature.integration.plex"),
    isFeatureEnabled("feature.integration.jellyfin"),
  ]);
  const [plexInstances, jellyfinInstances] = await Promise.all([
    plexOn ? getSyncableMediaInstances("plex") : Promise.resolve([]),
    jellyfinOn ? getSyncableMediaInstances("jellyfin") : Promise.resolve([]),
  ]);
  const servers: { server: MatchServer; slug: string }[] = [
    ...plexInstances.map((i) => ({ server: "plex" as const, slug: i.slug })),
    ...jellyfinInstances.map((i) => ({ server: "jellyfin" as const, slug: i.slug })),
  ];
  // Each server's own library selection, exactly as the sync reads it.
  const selectionKeys = servers.map((s) => selectionKeyOf(s.server, s.slug));
  const selectionRows = selectionKeys.length
    ? await prisma.setting.findMany({ where: { key: { in: selectionKeys } }, select: { key: true, value: true } })
    : [];
  const selection = new Map(selectionRows.map((r) => [r.key, parseLibrarySelection(r.value)]));

  // Every listing is appended one by one, never a spread push: a spread throws
  // RangeError past ~125k entries, which would mark a readable source down
  // (guardrail 5i).
  const entries: ServerMatchEntry[] = [];
  // Every Plex server first, then every Jellyfin one.
  for (const { server, slug } of servers) {
    if (signal?.aborted) break;
    try {
      const items = await listServerInstance(server, slug, selection.get(selectionKeyOf(server, slug)), signal);
      if (items === null) continue;
      for (const item of items) entries.push(item);
      sources.push({ service: server, instance: slug, ok: true, items: items.length });
    } catch (err) {
      console.warn(`[library-match] ${SERVER_LABEL[server]} "${slug}" could not be listed:`, err instanceof Error ? err.message : err);
      sources.push({ service: server, instance: slug, ok: false, items: 0 });
    }
  }
  return entries;
}

async function readArrs(sources: LibraryMatchSource[], signal?: AbortSignal): Promise<ArrMatchEntry[]> {
  const out: ArrMatchEntry[] = [];
  const enabled = { radarr: await isFeatureEnabled("feature.integration.radarr"), sonarr: await isFeatureEnabled("feature.integration.sonarr") };
  for (const service of ["radarr", "sonarr"] as const) {
    if (!enabled[service] || signal?.aborted) continue;
    for (const instance of await getSyncableArrInstances(service)) {
      if (signal?.aborted) break;
      try {
        const cfg = await getArrCfg(service, instance.slug);
        if (!cfg) continue;
        const rows = projectArrRows(service, instance.slug, await arrFetch<unknown>(cfg, service === "radarr" ? "/api/v3/movie" : "/api/v3/series"));
        for (const row of rows) out.push(row); // one by one, as above (guardrail 5i)
        sources.push({ service, instance: instance.slug, ok: true, items: rows.length });
      } catch (err) {
        console.warn(`[library-match] ${service} "${sanitizeForLog(instance.slug)}" could not be listed:`, arrErrorKind(err));
        sources.push({ service, instance: instance.slug, ok: false, kind: arrErrorKind(err), items: 0 });
      }
    }
  }
  return out;
}

/**
 * Judge, then fill the TMDB id of every flagged Sonarr series that carries none
 * (Sonarr v3, or v4's 0) from TMDB's own TVDB cross-reference — the mapping the
 * sync's Sonarr cache uses — and judge again with it. Only the flagged series
 * are resolved. The second pass is what makes the resolved id count: a server
 * item carrying it agrees and leaves the report, and a resolved suggestion
 * makes its flag fixable, which moves it up its kind before the stored list is
 * cut. A failed lookup leaves the first verdict.
 */
async function judgeWithTvdbSuggestions(entries: ServerMatchEntry[], arr: ArrMatchEntry[]): Promise<{ flags: MatchFlag[]; counts: MatchCounts }> {
  const first = judgeLibraryMatches(entries, arr);
  const unresolved = new Set<number>();
  for (const f of first.flags) {
    if (f.arr && f.arr.tmdbId === null && f.arr.tvdbId !== null) unresolved.add(f.arr.tvdbId);
  }
  if (unresolved.size === 0) return first;
  const { map } = await resolveTvdbToTmdb([...unresolved]).catch(() => ({ map: new Map<number, number>() }));
  if (map.size === 0) return first;
  const filled = arr.map((a) => {
    const tmdbId = a.tmdbId === null && a.tvdbId !== null && unresolved.has(a.tvdbId) ? map.get(a.tvdbId) : undefined;
    return tmdbId === undefined ? a : { ...a, tmdbId };
  });
  return judgeLibraryMatches(entries, filled);
}

/**
 * Run the check and store its report. Returns null when `signal` aborted part
 * way (guardrail 41) — nothing is stored then, and the previous report stays.
 */
export async function runLibraryMatchCheck(opts: { signal?: AbortSignal; now?: Date } = {}): Promise<LibraryMatchReport | null> {
  // The stored report as the run starts: a fix that drops one of its flags
  // while the servers are being listed is told apart from it at the end.
  const before = await readLibraryMatchReport();
  const sources: LibraryMatchSource[] = [];
  const [entries, arr] = await Promise.all([readMediaServers(sources, opts.signal), readArrs(sources, opts.signal)]);
  if (opts.signal?.aborted) return null;

  const { flags, counts } = await judgeWithTvdbSuggestions(entries, arr);
  if (opts.signal?.aborted) return null;

  const checkedAt = (opts.now ?? new Date()).toISOString();
  const sortedSources = sources.sort((a, b) => a.service.localeCompare(b.service) || a.instance.localeCompare(b.instance));
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw(REPORT_ROW_LOCK);
    // Under the report-row lock every fix serializes on: a flag the stored
    // report had when this run started and has lost since was dropped by a fix
    // during the run (guardrail 37e), and this run's listing may predate that
    // fix — so it stays dropped rather than coming back.
    const current = parseLibraryMatchReport((await tx.setting.findUnique({ where: { key: LIBRARY_MATCH_REPORT_KEY } }))?.value);
    const fixed = fixedDuringRun(before, current);
    const kept = fixed.size > 0 ? flags.filter((f) => !fixed.has(matchFlagKey(f))) : flags;
    const report: LibraryMatchReport = {
      version: 1,
      checkedAt,
      sources: sortedSources,
      counts: { ...counts, flagged: counts.flagged - (flags.length - kept.length) },
      flags: kept.slice(0, MAX_STORED_FLAGS),
      truncated: Math.max(0, kept.length - MAX_STORED_FLAGS),
    };
    const value = JSON.stringify(report);
    await tx.setting.upsert({
      where: { key: LIBRARY_MATCH_REPORT_KEY },
      create: { key: LIBRARY_MATCH_REPORT_KEY, value },
      update: { value },
    });
    return report;
  });
}

const matchFlagKey = (f: Pick<MatchFlag, "server" | "serverInstance" | "itemKey">) =>
  `${f.server}\u0000${f.serverInstance}\u0000${f.itemKey}`;

/** Flags the stored report lost between two reads of the SAME report (same checkedAt): the fixes that ran in between. */
function fixedDuringRun(before: LibraryMatchReport | null, current: LibraryMatchReport | null): Set<string> {
  const out = new Set<string>();
  if (!before || !current || before.checkedAt !== current.checkedAt) return out;
  const still = new Set(current.flags.map(matchFlagKey));
  for (const f of before.flags) {
    const key = matchFlagKey(f);
    if (!still.has(key)) out.add(key);
  }
  return out;
}

const nullableText = v.nullable(v.string());
const nullableInt = v.nullable(v.int());
const StoredFlag = v.object({
  kind: v.literal("wrongMatch", "noTmdbId", "yearMismatch"),
  server: v.literal("plex", "jellyfin"),
  serverInstance: v.string(),
  mediaType: v.literal("MOVIE", "TV"),
  itemKey: v.string(),
  title: nullableText,
  year: nullableInt,
  folder: nullableText,
  file: nullableText,
  path: nullableText,
  serverTmdbId: nullableInt,
  arr: v.nullable(v.object({
    service: v.literal("radarr", "sonarr"),
    instance: v.string(),
    tmdbId: nullableInt,
    tvdbId: nullableInt,
    title: nullableText,
    year: nullableInt,
  })),
  sibling: v.boolean(),
});
const StoredSource = v.object({
  service: v.literal("plex", "jellyfin", "radarr", "sonarr"),
  instance: v.string(),
  ok: v.boolean(),
  kind: v.optional(v.literal("auth", "timeout", "unreachable", "server", "notFound", "other")),
  items: v.int(),
});
const StoredReportShell = v.object({
  version: v.literal(1),
  checkedAt: v.string(),
  sources: v.array(v.unknown()),
  counts: v.object({ checked: v.int(), agreed: v.int(), notManaged: v.int(), flagged: v.int() }),
  flags: v.array(v.unknown()),
  truncated: v.optional(v.int()),
});

/**
 * The stored report, or null when none was stored, it is from another version,
 * or its counts aren't numbers. A flag or source that doesn't have its shape is
 * dropped: the fix route matches on a flag's server, instance and key, and the
 * page renders the rest. Exported for tests.
 */
export function parseLibraryMatchReport(value: string | null | undefined): LibraryMatchReport | null {
  if (!value) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    return null;
  }
  const shell = check(StoredReportShell, raw);
  if (!shell.ok) return null;
  const flags: MatchFlag[] = [];
  for (const f of shell.value.flags) {
    const parsed = check(StoredFlag, f);
    if (parsed.ok) flags.push(parsed.value);
  }
  const sources: LibraryMatchSource[] = [];
  for (const src of shell.value.sources) {
    const parsed = check(StoredSource, src);
    if (parsed.ok) sources.push(parsed.value);
  }
  const { version, checkedAt, counts, truncated } = shell.value;
  return { version, checkedAt, sources, counts, flags, truncated: truncated ?? 0 };
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
type TxClient = PrismaTxClient;
type ReportTx = Pick<TxClient, "$executeRaw" | "setting">;

/** Remove one item's flag from the stored report — the fix that resolved it, inside its transaction. */
export async function dropMatchFlagInTx(tx: ReportTx, server: "plex" | "jellyfin", serverInstance: string, itemKey: string): Promise<void> {
  await tx.$executeRaw(REPORT_ROW_LOCK);
  const row = await tx.setting.findUnique({ where: { key: LIBRARY_MATCH_REPORT_KEY } });
  const report = parseLibraryMatchReport(row?.value);
  if (!report) return;
  const flags = report.flags.filter((f) => !(f.server === server && f.serverInstance === serverInstance && f.itemKey === itemKey));
  const removed = report.flags.length - flags.length;
  if (removed === 0) return;
  // By the number removed: a listing that served one item twice stored it twice.
  const next: LibraryMatchReport = { ...report, flags, counts: { ...report.counts, flagged: Math.max(0, report.counts.flagged - removed) } };
  await tx.setting.update({ where: { key: LIBRARY_MATCH_REPORT_KEY }, data: { value: JSON.stringify(next) } });
}

type MoveTx = Pick<TxClient, "plexLibraryItem" | "jellyfinLibraryItem">;

const keysOf = (canonical: string | null, all: string[]): string[] =>
  Array.from(new Set([...(canonical ? [canonical] : []), ...all]));

/** One library row's item keys, whatever the server calls them. */
interface RowKeys { tmdbId: number; canonical: string | null; keys: string[] }

/** What a newly created target row starts with, until the next full sync. */
/** `year` as the library rows store it (text, e.g. "2017"). */
export interface MovedTitleDisplay { title: string | null; year: string | null }

/** The PlexLibraryItem / JellyfinLibraryItem calls the move makes, under one set of names. */
interface LibraryRowAdapter {
  holders(moved: string[]): Promise<RowKeys[]>;
  remove(tmdbId: number): Promise<unknown>;
  /** `canonical` given: the row's canonical copy moved, so it takes this one and its path is unknown. */
  setKeys(tmdbId: number, keys: string[], canonical?: string): Promise<unknown>;
  target(): Promise<Omit<RowKeys, "tmdbId"> | null>;
  createTarget(key: string): Promise<unknown>;
  updateTarget(canonical: string, keys: string[]): Promise<unknown>;
}

interface MoveScope {
  serverInstance: string;
  mediaType: "MOVIE" | "TV";
  correctTmdbId: number;
  filePath: string | null;
  display?: MovedTitleDisplay;
}

function rowWhere(tmdbId: number, scope: MoveScope) {
  return { tmdbId_mediaType_serverInstance: { tmdbId, mediaType: scope.mediaType, serverInstance: scope.serverInstance } };
}

function createData(scope: MoveScope) {
  return {
    tmdbId: scope.correctTmdbId, mediaType: scope.mediaType, serverInstance: scope.serverInstance, filePath: scope.filePath,
    ...(scope.display ? { title: scope.display.title, year: scope.display.year } : {}),
  };
}

function plexRows(tx: MoveTx, scope: MoveScope): LibraryRowAdapter {
  const { serverInstance, mediaType, correctTmdbId } = scope;
  const db = tx.plexLibraryItem;
  return {
    holders: async (moved) => (await db.findMany({
      where: { serverInstance, mediaType, tmdbId: { not: correctTmdbId }, OR: [{ plexRatingKey: { in: moved } }, { plexRatingKeys: { hasSome: moved } }] },
      select: { tmdbId: true, plexRatingKey: true, plexRatingKeys: true },
    })).map((h) => ({ tmdbId: h.tmdbId, canonical: h.plexRatingKey, keys: h.plexRatingKeys })),
    remove: (tmdbId) => db.deleteMany({ where: { tmdbId, mediaType, serverInstance } }),
    setKeys: (tmdbId, keys, canonical) => db.update({
      where: rowWhere(tmdbId, scope),
      data: canonical === undefined ? { plexRatingKeys: keys } : { plexRatingKey: canonical, plexRatingKeys: keys, filePath: null },
    }),
    target: async () => {
      const t = await db.findUnique({ where: rowWhere(correctTmdbId, scope), select: { plexRatingKey: true, plexRatingKeys: true } });
      return t ? { canonical: t.plexRatingKey, keys: t.plexRatingKeys } : null;
    },
    createTarget: (key) => db.create({ data: { ...createData(scope), plexRatingKey: key, plexRatingKeys: [key] } }),
    updateTarget: (canonical, keys) => db.update({ where: rowWhere(correctTmdbId, scope), data: { plexRatingKey: canonical, plexRatingKeys: keys } }),
  };
}

function jellyfinRows(tx: MoveTx, scope: MoveScope): LibraryRowAdapter {
  const { serverInstance, mediaType, correctTmdbId } = scope;
  const db = tx.jellyfinLibraryItem;
  return {
    holders: async (moved) => (await db.findMany({
      where: { serverInstance, mediaType, tmdbId: { not: correctTmdbId }, OR: [{ jellyfinItemId: { in: moved } }, { jellyfinItemIds: { hasSome: moved } }] },
      select: { tmdbId: true, jellyfinItemId: true, jellyfinItemIds: true },
    })).map((h) => ({ tmdbId: h.tmdbId, canonical: h.jellyfinItemId, keys: h.jellyfinItemIds })),
    remove: (tmdbId) => db.deleteMany({ where: { tmdbId, mediaType, serverInstance } }),
    setKeys: (tmdbId, keys, canonical) => db.update({
      where: rowWhere(tmdbId, scope),
      data: canonical === undefined ? { jellyfinItemIds: keys } : { jellyfinItemId: canonical, jellyfinItemIds: keys, filePath: null },
    }),
    target: async () => {
      const t = await db.findUnique({ where: rowWhere(correctTmdbId, scope), select: { jellyfinItemId: true, jellyfinItemIds: true } });
      return t ? { canonical: t.jellyfinItemId, keys: t.jellyfinItemIds } : null;
    },
    createTarget: (key) => db.create({ data: { ...createData(scope), jellyfinItemId: key, jellyfinItemIds: [key] } }),
    updateTarget: (canonical, keys) => db.update({ where: rowWhere(correctTmdbId, scope), data: { jellyfinItemId: canonical, jellyfinItemIds: keys } }),
  };
}

/**
 * A remapped server item's library rows (fix-match item mode), until the next
 * full sync rewrites them from the server: the item leaves every OTHER title's
 * row on its server — a row left with no copy is deleted, a row whose canonical
 * copy it was falls back to its next copy (path unknown until the sync) — and
 * joins the corrected title's row, created when the server held no copy of it
 * (with `display`'s title and year when the caller knows them). Only
 * `oldKey`/`newKey` move: the other copies of the old title stay exactly where
 * they were, which is the whole point of fixing one item (guardrail 37's
 * every-copy remap would have rematched a correctly matched copy too). Every
 * query is awaited in turn (guardrail 23c).
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
  display?: MovedTitleDisplay,
): Promise<void> {
  const scope: MoveScope = { serverInstance, mediaType, correctTmdbId, filePath, display };
  const rows = server === "plex" ? plexRows(tx, scope) : jellyfinRows(tx, scope);
  const moved = new Set([oldKey, newKey]);
  for (const h of await rows.holders([...moved])) {
    const rest = keysOf(h.canonical, h.keys).filter((k) => !moved.has(k));
    if (rest.length === 0) await rows.remove(h.tmdbId);
    else if (h.canonical !== null && moved.has(h.canonical)) await rows.setKeys(h.tmdbId, rest, rest[0]);
    else await rows.setKeys(h.tmdbId, rest);
  }
  const target = await rows.target();
  if (!target) {
    await rows.createTarget(newKey);
    return;
  }
  const canonical = target.canonical ?? newKey;
  await rows.updateTarget(canonical, keysOf(canonical, [...target.keys, newKey]));
}
