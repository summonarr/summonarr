// A list answer that is a bare array (guardrail 25: clients decode the array)
// cannot carry a "there is more" field, so a capped read says so in headers.
// Fetch `cap + 1` rows, then `splitAtCap` keeps `cap` and reports the overflow.

/** "true" when the answer was cut at the route's cap, "false" when it is the whole list. */
export const TRUNCATED_HEADER = "X-Truncated";
/** The cap the answer was cut at, so a client can word its notice. */
export const TRUNCATED_CAP_HEADER = "X-Truncated-Cap";

export function splitAtCap<T>(rows: readonly T[], cap: number): { rows: T[]; truncated: boolean } {
  const truncated = rows.length > cap;
  return { rows: truncated ? rows.slice(0, cap) : [...rows], truncated };
}

export function truncationHeaders(truncated: boolean, cap: number): Record<string, string> {
  return { [TRUNCATED_HEADER]: truncated ? "true" : "false", [TRUNCATED_CAP_HEADER]: String(cap) };
}
