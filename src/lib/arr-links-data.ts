// "Open in Radarr / Sonarr" — the data half: resolve a title on one configured
// instance to the URL of its page in that instance's web UI. One live read per
// click, through arrFetch (guardrail 5); nothing cached, nothing written.
import { arrFetch, getArrCfg, pickSeriesByTmdbId } from "./arr";
import { arrSettingKey } from "./arr-instances";
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
    if (service === "radarr") {
      if ("arrId" in target) {
        const movie = await arrFetch<{ titleSlug?: unknown }>(cfg, `/api/v3/movie/${target.arrId}`);
        const slug = titleSlugOf(movie?.titleSlug);
        return slug ? arrTitleUrl(base, service, slug) : base;
      }
      const movies = await arrFetch<Array<{ tmdbId?: unknown; titleSlug?: unknown }>>(cfg, `/api/v3/movie?tmdbId=${target.tmdbId}`);
      const row = Array.isArray(movies) ? movies.find((m) => m?.tmdbId === target.tmdbId) : undefined;
      const slug = titleSlugOf(row?.titleSlug);
      return slug ? arrTitleUrl(base, service, slug) : arrAddUrl(base, target.tmdbId);
    }
    if ("arrId" in target) {
      const series = await arrFetch<{ titleSlug?: unknown }>(cfg, `/api/v3/series/${target.arrId}`);
      const slug = titleSlugOf(series?.titleSlug);
      return slug ? arrTitleUrl(base, service, slug) : base;
    }
    // Sonarr can't filter its library by TMDB id; its lookup marks a series it
    // already has with a positive `id`, which is the cheap way to tell.
    const looked = await arrFetch<Array<{ tmdbId?: number; id?: unknown; titleSlug?: unknown }>>(
      cfg, `/api/v3/series/lookup?term=tmdb:${target.tmdbId}`,
    );
    const row = pickSeriesByTmdbId(Array.isArray(looked) ? looked : [], target.tmdbId);
    const inLibrary = typeof row?.id === "number" && row.id > 0;
    const slug = inLibrary ? titleSlugOf(row?.titleSlug) : null;
    return slug ? arrTitleUrl(base, service, slug) : arrAddUrl(base, target.tmdbId);
  } catch (err) {
    console.warn(`[arr-links] ${service} instance "${instance}" lookup failed:`, err instanceof Error ? err.message : err);
    return base;
  }
}

/**
 * The configured instances whose synced wanted/available cache holds this
 * title, in registry order — which "Open in …" links a detail page offers an
 * admin. Cache rows, not a live call: the page render must not wait on
 * Radarr/Sonarr, and the link itself resolves live on click.
 */
export async function arrInstancesHolding(service: ArrLinkService, tmdbId: number): Promise<Array<{ slug: string; name: string }>> {
  const where = { tmdbId };
  const select = { arrInstance: true } as const;
  const [configured, wanted, available] = await Promise.all([
    getSyncableArrInstances(service),
    service === "radarr" ? prisma.radarrWantedItem.findMany({ where, select }) : prisma.sonarrWantedItem.findMany({ where, select }),
    service === "radarr" ? prisma.radarrAvailableItem.findMany({ where, select }) : prisma.sonarrAvailableItem.findMany({ where, select }),
  ]);
  const holding = new Set([...wanted, ...available].map((r) => r.arrInstance));
  return configured.filter((i) => holding.has(i.slug)).map((i) => ({ slug: i.slug, name: i.name }));
}
