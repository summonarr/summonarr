// "Open in Radarr / Sonarr" — the pure half: where a title lives in an arr's
// own web UI. Zero imports. The data half (which title, which instance, which
// address) is arr-links-data.ts; the one entry point every link uses is
// GET /api/admin/arr/open, which resolves on click and redirects.
//
// Radarr's movie page is /movie/<titleSlug> (Radarr's titleSlug is the TMDB id
// as a string in v4+, but the slug is read from Radarr rather than assumed);
// Sonarr's series page is /series/<titleSlug> ("the-office-us"). A title the
// instance does not have yet opens its Add New search for the TMDB id, which
// both arrs accept as `?term=tmdb:<id>`.

export type ArrLinkService = "radarr" | "sonarr";

/**
 * The browser-facing base for an instance: the admin's External URL when set,
 * else the connection URL. Absolute http(s), no credentials, query or fragment
 * (an invalid stored value falls through to the next candidate). No trailing slash.
 */
export function arrBrowserBase(...candidates: Array<string | null | undefined>): string | null {
  for (const raw of candidates) {
    if (typeof raw !== "string" || raw.trim() === "") continue;
    try {
      const u = new URL(raw.trim());
      if (u.protocol !== "http:" && u.protocol !== "https:") continue;
      if (u.username || u.password) continue;
      return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
    } catch {
      continue;
    }
  }
  return null;
}

export function arrTitleUrl(base: string, service: ArrLinkService, titleSlug: string): string {
  return `${base}/${service === "radarr" ? "movie" : "series"}/${encodeURIComponent(titleSlug)}`;
}

export function arrAddUrl(base: string, tmdbId: number): string {
  return `${base}/add/new?${new URLSearchParams({ term: `tmdb:${tmdbId}` }).toString()}`;
}

/** A titleSlug Radarr/Sonarr sent, or null. Radarr's can be a number. */
export function titleSlugOf(v: unknown): string | null {
  if (typeof v === "number" && Number.isInteger(v) && v > 0) return String(v);
  if (typeof v === "string" && v.trim() !== "" && v.length <= 300) return v.trim();
  return null;
}

/** The query the in-app links send to /api/admin/arr/open. */
export function arrOpenHref(
  service: ArrLinkService,
  instance: string,
  target: { tmdbId: number } | { arrId: number },
): string {
  const q = new URLSearchParams({ service, instance });
  if ("tmdbId" in target) q.set("tmdbId", String(target.tmdbId));
  else q.set("arrId", String(target.arrId));
  return `/api/admin/arr/open?${q.toString()}`;
}
