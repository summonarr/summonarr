// A page's URL with ITS OWN query keys set or removed and everything else kept
// — other params, and the #fragment — for history.replaceState. Rewriting the
// whole query (`?tab=x`) dropped a deep link's other params and its anchor.
//
// Pure, so the unit suite pins it (tests/arr-call.test.mts).

/** `current` is window.location (or anything with its three parts); a null value removes the key. */
export function withQuery(
  current: { pathname: string; search: string; hash: string },
  owned: Readonly<Record<string, string | null>>,
): string {
  const q = new URLSearchParams(current.search);
  for (const [key, value] of Object.entries(owned)) {
    if (value === null) q.delete(key);
    else q.set(key, value);
  }
  const s = q.toString();
  return `${current.pathname}${s ? `?${s}` : ""}${current.hash}`;
}
