// "S01 · E05" for a play's season and episode. A missing episode number shows
// the season alone ("S01") — never "E00", which reads as a real episode 0 —
// and a missing season gives null (the caller shows its own placeholder).
// Zero-import: shared by server and client components.
const part = (prefix: "S" | "E", n: number): string => `${prefix}${String(n).padStart(2, "0")}`;

export function episodeLabel(
  season: number | null | undefined,
  episode: number | null | undefined,
): string | null {
  if (season == null) return null;
  const s = part("S", season);
  return episode == null ? s : `${s} · ${part("E", episode)}`;
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
  if (season != null) parts.push(part("S", season));
  if (episode != null) parts.push(part("E", episode));
  return parts.join(" · ");
}
