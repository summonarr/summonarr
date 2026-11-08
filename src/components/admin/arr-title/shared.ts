// Shared plumbing for the admin title manager's tabs (and the other admin
// Radarr/Sonarr pages): which title, how to talk to /api/admin/arr/*, and the
// labels every one of them shows.
import { useEffect, useRef } from "react";
import { useT } from "@/components/i18n/i18n-provider";
import { withBasePath } from "@/lib/base-path";
import { ANY_OBJECT, arrCall, type ArrCallResult } from "@/lib/client/arr-call";
import type { Schema } from "@/lib/validate";

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

export type ApiResult<T> = ArrCallResult<T>;

export interface ApiInit<T> {
  method?: string;
  body?: unknown;
  /** What the page reads off the answer (src/lib/client/arr-answers.ts); any JSON object when absent. */
  schema?: Schema<T>;
  /** The caller's abort: an unmount, a newer read of the same thing. */
  signal?: AbortSignal;
}

/**
 * A JSON call to one of the admin arr routes (arr-call.ts: a timeout, the
 * shape check, never a throw). A refusal's `error` (already translated by the
 * server) is passed through; no answer, an unreadable one or a timeout
 * becomes `fallback`. `path` is the route's own; the base path is added here.
 */
export function arrApi<T>(path: string, init: ApiInit<T> & { schema: Schema<T> }, fallback: string): Promise<ApiResult<T>>;
export function arrApi(path: string, init: ApiInit<Record<string, unknown>>, fallback: string): Promise<ApiResult<Record<string, unknown>>>;
export function arrApi<T>(path: string, init: ApiInit<T>, fallback: string): Promise<ApiResult<T>> {
  const schema = (init.schema ?? ANY_OBJECT) as Schema<T>;
  return arrCall(withBasePath(path), { method: init.method, body: init.body, schema, signal: init.signal, fallback });
}

export const SERVICE_LABEL: Record<ArrServiceName, string> = { radarr: "Radarr", sonarr: "Sonarr" };

/** An instance's key in a page's maps and its `?instance=` select: "service:slug". */
export const arrInstanceKey = (i: { service: ArrServiceName; slug: string }) => `${i.service}:${i.slug}`;

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
