// Library cleanup — how the report table is filtered and sorted (pure, no
// runtime imports). The report itself is computed on the server and arrives
// whole; everything here runs in the browser over those rows. The state round-
// trips through the URL (parse/serialize), so a filtered view survives a reload
// and can be shared, and every parameter is whitelisted on the way in.

import type { CleanupExclusion, CleanupRule } from "./library-cleanup";

export type CleanupViewMode = "candidates" | "held" | "all";
export type CleanupSortKey = "size" | "idle" | "added" | "lastPlayed" | "plays" | "votes" | "title";
export type CleanupSizeFilter = "any" | "1g" | "10g" | "50g" | "100g" | "unknown";

export const CLEANUP_VIEW_MODES: readonly CleanupViewMode[] = ["candidates", "held", "all"];
export const CLEANUP_SORT_KEYS: readonly CleanupSortKey[] = ["size", "idle", "added", "lastPlayed", "plays", "votes", "title"];
export const CLEANUP_SIZE_FILTERS: readonly CleanupSizeFilter[] = ["any", "1g", "10g", "50g", "100g", "unknown"];
const RULES: readonly CleanupRule[] = ["unwatched", "neverWatched", "votes"];
const EXCLUSIONS: readonly CleanupExclusion[] = [
  "recentlyAdded", "activeRequest", "recentlyFulfilled", "watchlisted", "playingNow", "airing", "protected", "upstreamUnchecked",
];

const GB = 1024 ** 3;
const SIZE_FLOOR: Record<Exclude<CleanupSizeFilter, "any" | "unknown">, number> = {
  "1g": GB,
  "10g": 10 * GB,
  "50g": 50 * GB,
  "100g": 100 * GB,
};

export interface CleanupViewState {
  view: CleanupViewMode;
  type: "all" | "MOVIE" | "TV";
  rule: "any" | CleanupRule;
  // "none" = nothing holds it back.
  excl: "any" | "none" | CleanupExclusion;
  // A media-server label ("plex", "jellyfin:remote"); "" = every server.
  server: string;
  // A Radarr/Sonarr instance (cleanupArrKey); "" = every one; "none" = in none.
  arr: string;
  size: CleanupSizeFilter;
  // Only titles the delete would act on: a candidate with something to delete.
  deletable: boolean;
  q: string;
  sort: CleanupSortKey;
  dir: "asc" | "desc";
}

export const CLEANUP_VIEW_DEFAULTS: CleanupViewState = {
  view: "candidates",
  type: "all",
  rule: "any",
  excl: "any",
  server: "",
  arr: "",
  size: "any",
  deletable: false,
  q: "",
  sort: "size",
  dir: "desc",
};

// Title reads A→Z by default; everything else biggest / longest / most first.
export function defaultCleanupSortDir(sort: CleanupSortKey): "asc" | "desc" {
  return sort === "title" ? "asc" : "desc";
}

export function cleanupArrKey(service: string, instance: string): string {
  return `${service}:${instance}`;
}

// Server labels and arr keys are short slugs; anything else is not a value we
// could ever have produced.
const SLUG_VALUE = /^[a-z0-9:_-]{1,80}$/;

export function parseCleanupView(params: { get(name: string): string | null }): CleanupViewState {
  const pick = <T extends string>(raw: string | null, allowed: readonly T[], fallback: T): T =>
    raw !== null && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
  const slug = (raw: string | null) => (raw !== null && SLUG_VALUE.test(raw) ? raw : "");
  const sort = pick(params.get("sort"), CLEANUP_SORT_KEYS, CLEANUP_VIEW_DEFAULTS.sort);
  return {
    view: pick(params.get("view"), CLEANUP_VIEW_MODES, CLEANUP_VIEW_DEFAULTS.view),
    type: pick(params.get("type"), ["all", "MOVIE", "TV"] as const, "all"),
    rule: pick(params.get("rule"), ["any", ...RULES] as const, "any"),
    excl: pick(params.get("excl"), ["any", "none", ...EXCLUSIONS] as const, "any"),
    server: slug(params.get("server")),
    arr: slug(params.get("arr")),
    size: pick(params.get("size"), CLEANUP_SIZE_FILTERS, "any"),
    deletable: params.get("deletable") === "1",
    q: (params.get("q") ?? "").slice(0, 200),
    sort,
    dir: pick(params.get("dir"), ["asc", "desc"] as const, defaultCleanupSortDir(sort)),
  };
}

// Only what differs from the defaults, so the plain page keeps a clean URL.
export function serializeCleanupView(s: CleanupViewState): string {
  const p = new URLSearchParams();
  const d = CLEANUP_VIEW_DEFAULTS;
  if (s.view !== d.view) p.set("view", s.view);
  if (s.type !== d.type) p.set("type", s.type);
  if (s.rule !== d.rule) p.set("rule", s.rule);
  if (s.excl !== d.excl) p.set("excl", s.excl);
  if (s.server) p.set("server", s.server);
  if (s.arr) p.set("arr", s.arr);
  if (s.size !== d.size) p.set("size", s.size);
  if (s.deletable) p.set("deletable", "1");
  if (s.q.trim()) p.set("q", s.q.trim());
  if (s.sort !== d.sort) p.set("sort", s.sort);
  if (s.dir !== defaultCleanupSortDir(s.sort)) p.set("dir", s.dir);
  return p.toString();
}

// Every filter except the free-text search and the sort is "off" at its default.
export function cleanupFiltersActive(s: CleanupViewState): boolean {
  const d = CLEANUP_VIEW_DEFAULTS;
  return s.view !== d.view || s.type !== d.type || s.rule !== d.rule || s.excl !== d.excl ||
    s.server !== "" || s.arr !== "" || s.size !== d.size || s.deletable || s.q.trim() !== "";
}

// The fields of a report row the view reads.
export interface CleanupViewRow {
  tmdbId: number;
  mediaType: "MOVIE" | "TV";
  title: string;
  servers: readonly string[];
  arr: ReadonlyArray<{ service: string; instance: string }>;
  sizeOnDisk: number | null;
  addedAt: string | null;
  lastPlayedAt: string | null;
  playCount: number;
  votes: number;
  idleDays: number | null;
  matched: readonly CleanupRule[];
  excludedBy: readonly CleanupExclusion[];
  candidate: boolean;
}

export function filterCleanupRows<T extends CleanupViewRow>(rows: readonly T[], s: CleanupViewState): T[] {
  const needle = s.q.trim().toLowerCase();
  return rows.filter((r) => {
    if (s.view === "candidates" && !r.candidate) return false;
    if (s.view === "held" && r.candidate) return false;
    if (s.deletable && !(r.candidate && r.arr.length > 0)) return false;
    if (s.type !== "all" && r.mediaType !== s.type) return false;
    if (s.rule !== "any" && !r.matched.includes(s.rule)) return false;
    if (s.excl === "none" && r.excludedBy.length > 0) return false;
    if (s.excl !== "any" && s.excl !== "none" && !r.excludedBy.includes(s.excl)) return false;
    if (s.server && !r.servers.includes(s.server)) return false;
    if (s.arr === "none" && r.arr.length > 0) return false;
    if (s.arr && s.arr !== "none" && !r.arr.some((a) => cleanupArrKey(a.service, a.instance) === s.arr)) return false;
    if (s.size === "unknown" && r.sizeOnDisk !== null) return false;
    if (s.size !== "any" && s.size !== "unknown" && (r.sizeOnDisk === null || r.sizeOnDisk < SIZE_FLOOR[s.size])) return false;
    if (needle && !r.title.toLowerCase().includes(needle)) return false;
    return true;
  });
}

const time = (iso: string | null) => (iso ? new Date(iso).getTime() : null);

export function sortCleanupRows<T extends CleanupViewRow>(rows: readonly T[], sort: CleanupSortKey, dir: "asc" | "desc"): T[] {
  const sign = dir === "asc" ? 1 : -1;
  // An unknown value (no size, no date) sorts LAST whichever the direction.
  const num = (a: number | null, b: number | null) =>
    a === null && b === null ? 0 : a === null ? 1 : b === null ? -1 : (a - b) * sign;
  const out = [...rows];
  out.sort((a, b) => {
    let c = 0;
    switch (sort) {
      case "size": c = num(a.sizeOnDisk, b.sizeOnDisk); break;
      case "idle": c = num(a.idleDays, b.idleDays); break;
      case "added": c = num(time(a.addedAt), time(b.addedAt)); break;
      // Never played is the OLDEST possible last play, not an unknown one: it
      // leads "oldest first" and trails "most recent first".
      case "lastPlayed": c = ((time(a.lastPlayedAt) ?? -Infinity) - (time(b.lastPlayedAt) ?? -Infinity)) * sign || 0; break;
      case "plays": c = (a.playCount - b.playCount) * sign; break;
      case "votes": c = (a.votes - b.votes) * sign; break;
      case "title": c = a.title.localeCompare(b.title) * sign; break;
    }
    return c || a.title.localeCompare(b.title) || a.tmdbId - b.tmdbId;
  });
  return out;
}
