// Links into the admin title manager and the Download Queue from every admin
// list that names a Radarr/Sonarr title — which tab the manager opens on from
// each list, the queue's link filters (`/admin/queue?q=` and
// `?service=&instance=&arrId=`), and which configured instances' synced cache
// holds a title. Pure: client tables and server pages import it alike.

import { isValidInstanceSlug } from "./arr-instances";

export type ManageService = "radarr" | "sonarr";
export type ManageTab = "settings" | "seasons" | "files" | "history";

/** The admin list a title manager is opened from. */
export type ManageContext =
  | "queue" | "history" | "blocklist" | "missing" | "cutoff" | "calendar" | "issue"
  // The request queue: a pushed title still waiting (its seasons / settings) or one already on disk (its files).
  | "requestApproved" | "requestAvailable";

/**
 * The tab the manager opens on from each list — what the admin most likely came
 * to look at: a download's own record (queue, history, blocklist), the file
 * below cutoff, the seasons with episodes missing or airing, and for an issue
 * the files of a movie or the seasons of a series. Never Seasons for Radarr.
 */
export function manageTabFor(context: ManageContext, service: ManageService): ManageTab {
  switch (context) {
    case "queue":
    case "history":
    case "blocklist":
      return "history";
    case "cutoff":
    case "requestAvailable":
      return "files";
    case "missing":
    case "calendar":
    case "requestApproved":
      return service === "sonarr" ? "seasons" : "settings";
    case "issue":
      return service === "sonarr" ? "seasons" : "files";
  }
}

/** One title on one instance — the queue's exact-title filter. */
export interface QueueTitleFilter {
  service: ManageService;
  instance: string;
  arrId: number;
}

export interface QueueLinkFilters {
  /** The title text filter, "" for none. */
  q: string;
  /** Exactly one title's downloads, or null. */
  title: QueueTitleFilter | null;
  /** The tab a link asked for — only "attention" (what the nav badge counts); absent = the page default. */
  filter?: "attention";
}

/** The Download Queue on its "needs attention" tab — where the nav badge's count lands. */
export const QUEUE_ATTENTION_HREF = "/admin/queue?filter=attention";

/** Longest `q` taken from a link — the same cap as the queue's own filter box. */
export const QUEUE_QUERY_MAX = 200;
// Radarr/Sonarr ids are database row ids: a positive 32-bit int.
const ARR_ID_RE = /^[1-9][0-9]{0,9}$/;
const MAX_ARR_ID = 2_147_483_647;

type SearchParamValue = string | string[] | undefined;

// A repeated parameter (`?q=a&q=b`) is read by its first value, like URLSearchParams.get.
const first = (v: SearchParamValue): string | undefined => (Array.isArray(v) ? v[0] : v);

/**
 * `/admin/queue`'s link filters, validated. `q` is trimmed, stripped of control
 * characters and capped at QUEUE_QUERY_MAX. The title filter needs all three of
 * a known service, a valid instance slug (absent = the default instance) and a
 * positive integer arrId — anything else drops the WHOLE title filter rather
 * than applying part of it, which would show another title's downloads.
 * `filter=attention` selects the attention tab; any other value is ignored.
 */
export function parseQueueLinkFilters(sp: Record<string, SearchParamValue>): QueueLinkFilters {
  const rawQ = first(sp.q);
  const q = typeof rawQ === "string" ? rawQ.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, QUEUE_QUERY_MAX).trim() : "";
  const service = first(sp.service);
  const instance = first(sp.instance) ?? "";
  const arrId = first(sp.arrId);
  let title: QueueTitleFilter | null = null;
  if (
    (service === "radarr" || service === "sonarr") &&
    isValidInstanceSlug(instance) &&
    typeof arrId === "string" &&
    ARR_ID_RE.test(arrId) &&
    Number(arrId) <= MAX_ARR_ID
  ) {
    title = { service, instance, arrId: Number(arrId) };
  }
  // The key is present only when set, so a parsed link compares equal to a
  // literal `{ q, title }` (deepEqual) and the page's default needs no change.
  return first(sp.filter) === "attention" ? { q, title, filter: "attention" } : { q, title };
}

/** The filters' identity by value — two links asking for the same filters read the same. */
export function queueLinkKey(f: QueueLinkFilters): string {
  return `${f.q}\u0000${f.title ? `${f.title.service}\u0000${f.title.instance}\u0000${f.title.arrId}` : ""}\u0000${f.filter ?? ""}`;
}

/** The Download Queue filtered to exactly this title's downloads. */
export function queueTitleHref(ref: QueueTitleFilter): string {
  const q = new URLSearchParams({ service: ref.service, instance: ref.instance, arrId: String(ref.arrId) });
  return `/admin/queue?${q.toString()}`;
}

/** A queue row is this title's download: same service, same instance, same arr id. */
export function matchesQueueTitle(
  row: { service: string; instance: string; arrMediaId: number | null },
  filter: QueueTitleFilter,
): boolean {
  return row.service === filter.service && row.instance === filter.instance && row.arrMediaId === filter.arrId;
}

/**
 * Per TMDB id, the configured instances whose synced wanted/available cache
 * holds it — arrInstancesHolding's answer for a whole list in one read. Kept
 * in the configured (registry) order, each instance once; a cache row for an
 * instance that is no longer configured is ignored.
 */
export function arrHoldersByTmdbId<I extends { slug: string; name: string }>(
  configured: readonly I[],
  rows: ReadonlyArray<{ tmdbId: number; arrInstance: string }>,
): Map<number, Array<{ slug: string; name: string }>> {
  const held = new Map<number, Set<string>>();
  for (const r of rows) {
    let set = held.get(r.tmdbId);
    if (!set) held.set(r.tmdbId, (set = new Set()));
    set.add(r.arrInstance);
  }
  const out = new Map<number, Array<{ slug: string; name: string }>>();
  for (const [tmdbId, slugs] of held) {
    const holders = configured.filter((i) => slugs.has(i.slug)).map(({ slug, name }) => ({ slug, name }));
    if (holders.length > 0) out.set(tmdbId, holders);
  }
  return out;
}
