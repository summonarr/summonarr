// Client half of "instant, then live" (src/lib/arr-snapshot.ts): read the last
// answer the server kept for an admin arr read, so a page paints it at once while
// its own live load is out. Display only — every action re-checks live on the
// server (guardrail 5e).

/** The response header carrying when a snapshot was read (ISO 8601). */
export const SNAPSHOT_HEADER = "X-Summonarr-Snapshot-At";

/** The snapshot twin of a read's URL. */
export function cachedUrl(url: string): string {
  return `${url}${url.includes("?") ? "&" : "?"}cached=1`;
}

export interface ArrSnapshot<T> {
  data: T;
  /** When the live read this answer came from finished (ISO 8601). */
  at: string;
}

/**
 * The last answer the server kept for `url`, or null when there is none (204),
 * the read failed, or the answer isn't a snapshot. Never throws: a missing
 * snapshot only means the page shows its usual loading state.
 */
export async function readArrSnapshot<T>(url: string, init: { signal?: AbortSignal } = {}): Promise<ArrSnapshot<T> | null> {
  try {
    const res = await fetch(cachedUrl(url), { signal: init.signal, cache: "no-store" });
    if (res.status !== 200) return null;
    const at = res.headers.get(SNAPSHOT_HEADER);
    if (!at || Number.isNaN(Date.parse(at))) return null;
    return { data: (await res.json()) as T, at };
  } catch {
    return null;
  }
}
