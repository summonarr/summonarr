// The TRaSH admin section's ?service= / ?variant= params, read the way the
// server pages read them (app/(app)/admin/trash-guides/_shared.ts). Pure and
// directive-free (tests/trash-nav-params.test.mts).
import type { TrashService } from "./types";

/** `?service=sonarr` is Sonarr; anything else (absent, "SONARR", junk) is Radarr, as on the server. */
export function parseTrashService(raw: string | null): TrashService {
  return raw === "sonarr" ? "SONARR" : "RADARR";
}

/** The `?variant=` slug when it names an offered instance, else the default (""). */
export function parseTrashVariant(raw: string | null, offered: readonly { slug: string }[]): string {
  return raw && offered.some((i) => i.slug === raw) ? raw : "";
}

/**
 * The query a tab link carries: the view as it was READ, never the raw params.
 * Radarr and the default instance are the absent params, so a junk
 * ?service= or ?variant= can't ride along onto every tab.
 */
export function trashNavQuery(service: TrashService, variant: string): string {
  const params = new URLSearchParams();
  if (service === "SONARR") params.set("service", "sonarr");
  if (variant !== "") params.set("variant", variant);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}
