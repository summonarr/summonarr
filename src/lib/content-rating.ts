// Parental controls: a single per-user cap (User.maxContentRating) that governs
// BOTH movies and TV. US movies use MPAA certifications; US TV uses the TV
// Parental Guidelines. We map every certification onto one unified maturity rank
// so an admin can set one familiar MPAA-style cap (e.g. "PG-13") and have it apply
// to TV as well (PG-13 ≈ TV-14). A title exceeds the cap when its rank is strictly
// higher. Enforced at the request chokepoint (POST /api/requests + bulk); ADMIN
// bypasses. Server + client safe (no imports, no Date/Math.random).

const RANK: Record<string, number> = {
  // MPAA (movies)
  G: 0,
  PG: 1,
  "PG-13": 2,
  R: 3,
  "NC-17": 4,
  // US TV Parental Guidelines, aligned to the MPAA scale by audience age
  "TV-Y": 0,
  "TV-Y7": 0,
  "TV-G": 0,
  "TV-PG": 1,
  "TV-14": 2,
  "TV-MA": 3,
};

// The values an admin may assign as a cap (the familiar MPAA ladder, low→high).
// One cap applies to both media types via RANK. "" ⇒ no cap.
export const CONTENT_RATING_CAPS = ["G", "PG", "PG-13", "R", "NC-17"] as const;
export type ContentRatingCap = (typeof CONTENT_RATING_CAPS)[number];

export function isValidContentRatingCap(v: string): v is ContentRatingCap {
  return (CONTENT_RATING_CAPS as readonly string[]).includes(v);
}

function normalize(cert: string | null | undefined): string | null {
  if (!cert) return null;
  const c = cert.trim().toUpperCase();
  return c.length ? c : null;
}

// True when a title's certification is more mature than the user's cap. An absent
// cap ⇒ nothing exceeds. An unknown/unrated or unrecognized certification (not on
// either ladder — e.g. "NR", a non-US rating, or empty) is treated as NOT exceeding
// (allowed), to avoid over-blocking titles TMDB has no US certification for.
export function exceedsCap(cert: string | null | undefined, cap: string | null | undefined): boolean {
  const capN = normalize(cap);
  if (capN === null || !(capN in RANK)) return false;
  const certN = normalize(cert);
  if (certN === null || !(certN in RANK)) return false;
  return RANK[certN] > RANK[capN];
}
