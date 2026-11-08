// The Radarr/Sonarr service that manages a title of this media type — the name
// the UI shows beside a file, a mismatch or a confirmation. Zero imports, so
// client components and the unit suite load it as is.
export function arrServiceName(mediaType: string): "Radarr" | "Sonarr" {
  return mediaType === "MOVIE" ? "Radarr" : "Sonarr";
}
