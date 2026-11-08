// A stable, pleasant poster/avatar wash per title or person, so a card's
// radial accent and a leaderboard's avatar keep their colour across renders,
// reorderings and pages without depending on TMDB colours. Hashed from a seed
// (a title, an id), never from a list position: a rank-indexed colour changed
// whenever the ranking did.
export function accentFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  // Mix the bits (murmur3's finalizer) so near-identical seeds — two ids or
  // titles a character apart — land far apart on the colour wheel instead of
  // a degree or two.
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  const hue = (h >>> 0) % 360;
  return `oklch(0.38 0.08 ${hue})`;
}
