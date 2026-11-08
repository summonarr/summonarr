// Whether the viewer's own requests light up a detail page's MAIN Request
// button — the one that posts without an arrInstance and so is auto-routed.
//
// That button lands on the default instance, or on the named instance whose
// auto-route rule matches THIS title (request-create.ts routes it the same way,
// falling back to the default). A request the viewer made on some OTHER named
// instance (an explicit "Request on X") belongs to that instance's own button
// (resolveNamedInstanceTargets); counting it here showed the main button as
// Requested and blocked a valid default-instance request. 4K has its own button.
//
// Detail pages only. The grids stay default-only (request-availability.ts).

import { getArrInstancesWithConfigured } from "./arr-instance-registry";
import { DEFAULT_ARR_INSTANCE, FOURK_ARR_INSTANCE, routeMediaToSlug, type RoutableMedia } from "./arr-instances";

// Pure: `requestSlugs` is the arrInstance of each of the viewer's live
// (non-DECLINED) requests on the title; `autoRouteSlug` is where the main
// button's request would be routed ("" when no rule matches).
export function mainButtonRequested(requestSlugs: readonly string[], autoRouteSlug: string): boolean {
  return requestSlugs.some(
    (slug) => slug !== FOURK_ARR_INSTANCE && (slug === DEFAULT_ARR_INSTANCE || slug === autoRouteSlug),
  );
}

// The TMDB fields the router reads, from a detail payload the page already
// loaded. Same mapping as request-create.ts.
export function routableMedia(media: {
  genreList?: { id: number }[];
  originalLanguage?: string | null;
  originCountryCodes?: string[];
}): RoutableMedia {
  return {
    genreIds: media.genreList?.map((g) => g.id) ?? [],
    originalLanguage: media.originalLanguage ?? null,
    originCountries: media.originCountryCodes ?? [],
  };
}

// The registry is read only when the answer depends on it: a default-instance
// request decides on its own, and with no named-instance request there is
// nothing for the route to match.
export async function resolveMainButtonRequested(
  mediaType: "MOVIE" | "TV",
  requestSlugs: readonly string[],
  media: RoutableMedia,
): Promise<boolean> {
  if (requestSlugs.includes(DEFAULT_ARR_INSTANCE)) return true;
  if (!requestSlugs.some((slug) => slug !== FOURK_ARR_INSTANCE)) return false;
  // Routed over CONFIGURED instances only, exactly as request-create.ts does.
  const { all, configured } = await getArrInstancesWithConfigured(mediaType === "MOVIE" ? "radarr" : "sonarr");
  const autoRouteSlug = routeMediaToSlug(all.filter((i) => configured.has(i.slug)), media);
  return mainButtonRequested(requestSlugs, autoRouteSlug);
}
