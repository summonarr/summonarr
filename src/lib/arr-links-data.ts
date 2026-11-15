// "Open in Radarr / Sonarr" — the data half: resolve a title on one configured
// instance to the URL of its page in that instance's web UI. One live read per
// click, through arrFetch (guardrail 5); nothing cached, nothing written.
import { arrFetch, getArrCfg, lookupSeriesByTmdbId, type ArrCfg } from "./arr";
import { posInt } from "./arr-parse";
import { arrSettingKey, isValidInstanceSlug } from "./arr-instances";
import { sanitizeForLog } from "./sanitize";
import { getSyncableArrInstances } from "./arr-instance-registry";
import { arrAddUrl, arrBrowserBase, arrTitleUrl, titleSlugOf, type ArrLinkService } from "./arr-links";
import { prisma } from "./prisma";

export class ArrLinkInstanceError extends Error {}

export type ArrLinkTarget = { tmdbId: number } | { arrId: number };

/** The instance's browser base, or null when neither address is usable. Instance must be configured. */
export async function arrInstanceBrowserBase(service: ArrLinkService, instance: string): Promise<string | null> {
  const configured = await getSyncableArrInstances(service);
  if (!configured.some((i) => i.slug === instance)) throw new ArrLinkInstanceError(instance);
  const rows = await prisma.setting.findMany({
    where: { key: { in: [arrSettingKey(service, instance, "ExternalUrl"), arrSettingKey(service, instance, "Url")] } },
  });
  const get = (field: "ExternalUrl" | "Url") => rows.find((r) => r.key === arrSettingKey(service, instance, field))?.value;
  return arrBrowserBase(get("ExternalUrl"), get("Url"));
}

// The title's own slug on the instance by its arr id, or null when the arr has none.
async function slugByArrId(cfg: ArrCfg, service: ArrLinkService, arrId: number): Promise<string | null> {
  const row = await arrFetch<{ titleSlug?: unknown } | null>(cfg, `/api/v3/${service === "radarr" ? "movie" : "series"}/${arrId}`);
  return titleSlugOf(row?.titleSlug);
}

// The title's slug when the instance HOLDS it (by tmdb id), else null — an Add link then.
async function heldSlugByTmdbId(cfg: ArrCfg, service: ArrLinkService, tmdbId: number): Promise<string | null> {
  if (service === "radarr") {
    const movies = await arrFetch<unknown>(cfg, `/api/v3/movie?tmdbId=${tmdbId}`);
    const row = Array.isArray(movies) ? (movies as Array<{ tmdbId?: unknown; titleSlug?: unknown } | null>).find((m) => m?.tmdbId === tmdbId) : undefined;
    return titleSlugOf(row?.titleSlug);
  }
  // Sonarr can't filter its library by TMDB id; its lookup marks a series it
  // already has with a positive `id`, which is the cheap way to tell. The
  // client's one lookup and wrong-series guard, Sonarr-sourced only: a TMDB
  // cross-reference could name a series by TVDB id, never one in the library.
  const row = await lookupSeriesByTmdbId(cfg, tmdbId, { tvdbCrossRef: false });
  return posInt(row?.id) !== null ? titleSlugOf(row?.titleSlug) : null;
}

/**
 * Where the link should land. Falls back to the instance's home page when the
 * title can't be looked up (the arr is down, or answered something
 * unexpected) — the admin clicked to go to Radarr/Sonarr, and that still works.
 */
export async function resolveArrOpenUrl(service: ArrLinkService, instance: string, target: ArrLinkTarget): Promise<string | null> {
  const base = await arrInstanceBrowserBase(service, instance);
  if (!base) return null;
  const cfg = await getArrCfg(service, instance);
  if (!cfg) return base;
  try {
    if ("arrId" in target) {
      const slug = await slugByArrId(cfg, service, target.arrId);
      return slug ? arrTitleUrl(base, service, slug) : base;
    }
    const slug = await heldSlugByTmdbId(cfg, service, target.tmdbId);
    return slug ? arrTitleUrl(base, service, slug) : arrAddUrl(base, target.tmdbId);
  } catch (err) {
    console.warn("[arr-links] %s instance %s lookup failed:", service, sanitizeForLog(instance), sanitizeForLog(err instanceof Error ? err.message : err));
    return base;
  }
}

/**
 * Every configured instance, in registry order, and whether its synced
 * wanted/available cache holds this title — a detail page offers an admin
 * "Manage in" / "Open in" for a holder and "Add to" for the rest. Cache rows,
 * not a live call: the page render must not wait on Radarr/Sonarr, and every
 * action resolves live on click (a title added since the last sync reads as
 * not held until the next one; its Add answers "already there").
 */
export async function arrInstancesForTitle(service: ArrLinkService, tmdbId: number): Promise<Array<{ slug: string; name: string; holds: boolean }>> {
  const where = { tmdbId };
  const select = { arrInstance: true } as const;
  const [configured, wanted, available] = await Promise.all([
    getSyncableArrInstances(service),
    service === "radarr" ? prisma.radarrWantedItem.findMany({ where, select }) : prisma.sonarrWantedItem.findMany({ where, select }),
    service === "radarr" ? prisma.radarrAvailableItem.findMany({ where, select }) : prisma.sonarrAvailableItem.findMany({ where, select }),
  ]);
  const holding = new Set([...wanted, ...available].map((r) => r.arrInstance));
  return configured.map((i) => ({ slug: i.slug, name: i.name, holds: holding.has(i.slug) }));
}

/**
 * A detail-page deep link to the title manager — `?manage=<service>:<slug>`
 * (`:` alone for the default instance) and an optional `&tab=` — or null when
 * it names nothing valid. Only ever selects among the page's own instances.
 */
export function parseManageLink(
  manage: unknown,
  tab: unknown,
  service: ArrLinkService,
): { instance: string; tab: "settings" | "seasons" | "files" | "history" | undefined } | null {
  if (typeof manage !== "string") return null;
  const m = /^(radarr|sonarr):([a-z0-9_-]{0,40})$/.exec(manage);
  if (!m || m[1] !== service || !isValidInstanceSlug(m[2])) return null;
  const tabs = ["settings", "seasons", "files", "history"] as const;
  return { instance: m[2], tab: typeof tab === "string" && (tabs as readonly string[]).includes(tab) ? (tab as (typeof tabs)[number]) : undefined };
}
