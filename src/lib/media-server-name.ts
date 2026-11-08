// A media server's own name, spelled once for every surface that shows it
// (the fix-match dialogs, the heatmap drill-down). Brand names: never translated;
// a sentence that places one does so through its own catalog placeholder.
export type MediaServerKind = "plex" | "jellyfin";

export function mediaServerName(server: MediaServerKind): string {
  return server === "jellyfin" ? "Jellyfin" : "Plex";
}
