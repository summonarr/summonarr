// A StatCard delta's tone. Pure and zero-import, so the unit suite loads it.

export type DeltaTone = "up" | "down" | "neutral";

/** A delta label's tone when the caller gave none, read from its first
 *  character: ASCII +/-, the Unicode minus Intl's signDisplay writes, or an
 *  up/down arrow. Anything else is neutral. */
export function deltaToneOf(delta: string): DeltaTone {
  const lead = delta.trimStart().charAt(0);
  if (lead === "+" || lead === "\u25b2" || lead === "\u2191") return "up";
  if (lead === "-" || lead === "\u2212" || lead === "\u25bc" || lead === "\u2193") return "down";
  return "neutral";
}
