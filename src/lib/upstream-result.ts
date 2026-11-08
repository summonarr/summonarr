// What an upstream API call (TMDB, OMDb, Plex, Jellyfin, Radarr/Sonarr…)
// came back with, keeping the two kinds of "nothing" apart:
//
//   "ok"      the upstream answered with the value (an empty list is a value)
//   "missing" the upstream ANSWERED that there is nothing there (a 404, "no
//             such title") — an answer, so it may be cached
//   "failed"  no usable answer: network error, timeout, 5xx, 429, a refused
//             key, a body that failed its shape check
//
// THE RULE: a failure is never cached, stored or shown as "not found" or
// "empty". It says nothing about the title; the next call may well succeed.
// Cache through `isCacheable`, and show a failure as a failure.
//
//   async function getMovie(id: number): Promise<UpstreamResult<Movie>> {
//     let res: Response;
//     try { res = await safeFetchTrusted(url, opts); } catch (err) { return upstreamFailed(err); }
//     if (res.status === 404) return upstreamMissing();
//     if (!res.ok) return upstreamFailed(new Error(`HTTP ${res.status}`));
//     return upstreamChecked(MovieSchema, await res.json().catch(() => undefined));
//   }
//
// Imports only the zero-import validator, so it loads anywhere
// (tests/upstream-result.test.mts).
import { check, type Infer, type Schema } from "./validate";

export type UpstreamOk<T> = { kind: "ok"; value: T };
export type UpstreamMissing = { kind: "missing" };
export type UpstreamFailed = { kind: "failed"; error: unknown };
export type UpstreamResult<T> = UpstreamOk<T> | UpstreamMissing | UpstreamFailed;

/** An answer: the value, or "there is nothing there". Never a failure. */
export type UpstreamAnswer<T> = UpstreamOk<T> | UpstreamMissing;

export function upstreamOk<T>(value: T): UpstreamOk<T> {
  return { kind: "ok", value };
}

export function upstreamMissing(): UpstreamMissing {
  return { kind: "missing" };
}

/** `error` is for logs; it may quote a URL or a key, so sanitize before printing. */
export function upstreamFailed(error: unknown): UpstreamFailed {
  return { kind: "failed", error };
}

/**
 * A payload checked against `schema`: "ok" with the checked value, else
 * "failed" — a malformed answer is a broken upstream, never "missing".
 */
export function upstreamChecked<S extends Schema<unknown>>(schema: S, payload: unknown): UpstreamResult<Infer<S>> {
  const checked = check(schema, payload);
  return checked.ok ? upstreamOk(checked.value) : upstreamFailed(new Error(`unexpected payload: ${checked.error}`));
}

/** True for an answer ("ok" or "missing"), false for a failure. The only gate a cache write may use. */
export function isCacheable<T>(result: UpstreamResult<T>): result is UpstreamAnswer<T> {
  return result.kind !== "failed";
}

/**
 * The value, or `fallback` for "missing" AND "failed". It forgets the
 * difference, so use it only where a failure is reported some other way, and
 * never to decide what to cache or store.
 */
export function valueOr<T, F>(result: UpstreamResult<T>, fallback: F): T | F {
  return result.kind === "ok" ? result.value : fallback;
}

/** Transforms an "ok" value; "missing" and "failed" pass through unchanged. */
export function mapUpstream<T, U>(result: UpstreamResult<T>, fn: (value: T) => U): UpstreamResult<U> {
  return result.kind === "ok" ? upstreamOk(fn(result.value)) : result;
}
