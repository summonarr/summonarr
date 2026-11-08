// "S01 · E05" for a play's season and episode. A missing episode number shows
// the season alone ("S01") — never "E00", which reads as a real episode 0 —
// and a missing season gives null (the caller shows its own placeholder).
// Zero-import: shared by server and client components.
export function episodeLabel(
  season: number | null | undefined,
  episode: number | null | undefined,
): string | null {
  if (season == null) return null;
  const s = `S${String(season).padStart(2, "0")}`;
  return episode == null ? s : `${s} · E${String(episode).padStart(2, "0")}`;
}

// The live-session form (Now playing, Recent plays): each part the server
// reported, the other dropped, so a missing season still shows "E05" and
// nothing known gives "" — never "S00 · E00". The two cards append the
// episode title themselves.
export function formatSeasonEpisode(
  season: number | null | undefined,
  episode: number | null | undefined,
): string {
  const parts: string[] = [];
  if (season != null) parts.push(`S${String(season).padStart(2, "0")}`);
  if (episode != null) parts.push(`E${String(episode).padStart(2, "0")}`);
  return parts.join(" · ");
}
