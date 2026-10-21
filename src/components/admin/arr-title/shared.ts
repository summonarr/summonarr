// Shared plumbing for the admin title manager's tabs: which title, how to talk
// to /api/admin/arr/title/*, and the error text a refusal carries.
import { useEffect, useRef } from "react";
import { useT } from "@/components/i18n/i18n-provider";
import { withBasePath } from "@/lib/base-path";

export type ArrServiceName = "radarr" | "sonarr";

/** One title on one instance, by the arr's own id. */
export interface TitleRef {
  service: ArrServiceName;
  instance: string;
  arrId: number;
}

export function titleQuery(ref: TitleRef, extra: Record<string, string | number> = {}): string {
  const q = new URLSearchParams({ service: ref.service, instance: ref.instance, id: String(ref.arrId) });
  for (const [k, v] of Object.entries(extra)) q.set(k, String(v));
  return q.toString();
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string };

/**
 * A JSON call to one of the title routes. A refusal's `error` (already
 * translated by the server) is passed through; a network failure or an
 * unreadable answer becomes `fallback`.
 */
export async function arrApi<T>(path: string, init: { method?: string; body?: unknown } | undefined, fallback: string): Promise<ApiResult<T>> {
  try {
    const res = await fetch(withBasePath(path), {
      method: init?.method ?? "GET",
      ...(init?.body !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(init.body) } : {}),
    });
    const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
    if (!res.ok || data === null) return { ok: false, error: data?.error ?? fallback };
    return { ok: true, data };
  } catch {
    return { ok: false, error: fallback };
  }
}

export const SERVICE_LABEL: Record<ArrServiceName, string> = { radarr: "Radarr", sonarr: "Sonarr" };

/**
 * The translator through a ref, for loaders that run from effects: the
 * provider hands out a new `t` whenever the catalog object is re-created (a
 * router.refresh does that), and as an effect dependency that re-ran every read.
 */
export function useTRef() {
  const t = useT();
  const ref = useRef(t);
  useEffect(() => {
    ref.current = t;
  }, [t]);
  return ref;
}
