// How Radarr/Sonarr paths compare: either separator, no trailing one, and a
// Windows drive path case-insensitively ("C:\Movies" and "c:/movies/" are one
// place). Zero imports, so the pure title and storage modules (and the client
// components that import them) share ONE rule for disk matching, root-folder
// lookup and move detection.

/**
 * A path as a comparable string. The trailing separators go in one slice,
 * never a /\/+$/ regex (it backtracks over every run of separators — guardrail
 * 5i), and a lone "/" stays "/".
 */
export function comparablePath(p: string): string {
  const s = p.replace(/\\/g, "/");
  let end = s.length;
  while (end > 1 && s.charCodeAt(end - 1) === 47) end--;
  const t = end === s.length ? s : s.slice(0, end);
  return /^[A-Za-z]:/.test(t) ? t.toLowerCase() : t;
}

/** Whether `path` is `folder` or sits under it, whole segments only. Both already comparable. */
export function isUnderComparable(path: string, folder: string): boolean {
  return path === folder || path.startsWith(folder.endsWith("/") ? folder : `${folder}/`);
}
