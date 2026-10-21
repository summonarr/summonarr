// Pure helpers for the admin activity bar lists (HorizontalBars in
// src/components/admin/activity-ui.tsx). Zero-import, so the "use client"
// component and the unit suite share one definition.

/**
 * Merge bar items that share a display LABEL, summing their counts.
 *
 * Why: several distinct stored values can render as ONE label. bucketLabel
 * maps both the SQL's 'Unknown' bucket and an upstream literal 'unknown'
 * (device, player and platform are stored verbatim) to the translated
 * "Unknown", and the label is also the row's React key — so the chart drew
 * two identical bars and React warned about a duplicate key.
 *
 * Each merged item keeps its FIRST occurrence's position, so a caller's own
 * order (decades are listed by decade, not by count) survives. Only when the
 * input was already count-descending is the result re-sorted that way (stably),
 * since a merged item can outgrow the ones above it. No duplicate ⇒ the input
 * array itself is returned; inputs are never mutated.
 */
export function foldBarItems<T extends { label: string; count: number }>(items: readonly T[]): T[] {
  const index = new Map<string, number>();
  const out: T[] = [];
  let merged = false;
  for (const it of items) {
    const at = index.get(it.label);
    if (at === undefined) {
      index.set(it.label, out.length);
      out.push(it);
      continue;
    }
    merged = true;
    out[at] = { ...out[at], count: out[at].count + it.count };
  }
  if (!merged) return items as T[];
  const wasDescending = items.every((it, i) => i === 0 || items[i - 1].count >= it.count);
  return wasDescending ? out.sort((a, b) => b.count - a.count) : out;
}
