// The library lists the settings pickers read from /api/settings/{plex,jellyfin}/libraries
// (server-library-picker.ts), checked and brought to one shape. Plex answers
// sections ({ key, title, type }), Jellyfin media folders ({ id, name,
// collectionType }); the stored selection is the key/id in both cases, and it
// only means something on the server it was listed from.
import { check, v } from "../validate";

export type LibraryService = "plex" | "jellyfin";

export interface LibraryItem {
  /** The section key (Plex) or folder id (Jellyfin): what the selection stores. */
  id: string;
  title: string;
  /** "mixed": a Jellyfin library with no single type (it holds either). */
  kind: "movie" | "tv" | "mixed";
}

const PlexSections = v.array(v.object({ key: v.string(), title: v.string(), type: v.string() }));
const JellyfinFolders = v.array(v.object({ id: v.string(), name: v.string(), collectionType: v.string() }));

/**
 * The listed libraries, or null when the answer isn't the list this route
 * sends (a proxy's JSON error page, a non-array): the picker then shows its
 * load error instead of crashing on a `.map` during render.
 */
export function parseLibraryItems(service: LibraryService, data: unknown): LibraryItem[] | null {
  if (service === "plex") {
    const parsed = check(PlexSections, data);
    if (!parsed.ok) return null;
    return parsed.value
      .filter((s) => s.key !== "")
      .map((s) => ({ id: s.key, title: s.title, kind: s.type === "movie" ? "movie" : "tv" }));
  }
  const parsed = check(JellyfinFolders, data);
  if (!parsed.ok) return null;
  return parsed.value
    .filter((f) => f.id !== "")
    .map((f) => ({ id: f.id, title: f.name, kind: f.collectionType === "movies" ? "movie" : f.collectionType === "tvshows" ? "tv" : "mixed" }));
}

/** The libraries route for one server; `instance` "" is the default server. */
export function librariesPath(service: LibraryService, instance = ""): string {
  const base = `/api/settings/${service}/libraries`;
  return instance ? `${base}?instance=${encodeURIComponent(instance)}` : base;
}
