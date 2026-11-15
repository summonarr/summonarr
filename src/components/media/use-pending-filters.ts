"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  canonicalQuery,
  reconcilePending,
  withPending,
  type PendingDelta,
} from "@/lib/browse-filters";

// The URL-editing half of FilterBar and TopFilterBar (no client store —
// guardrail 9; the URL stays the state).
//
// `searchParams` reflects the COMMITTED url and router.push is async, so two
// quick changes used to build the second query from a snapshot that still held
// the first filter's OLD value, wiping a change the user had just made. The
// changes still in flight are kept as a DELTA and reapplied on top of whatever
// the URL says, which stays correct for a third change too.
//
// The delta is also STATE, not only a ref: the controls are controlled by the
// committed URL, and without a re-render they snapped back to their old values
// for the whole server round-trip (and the hide-available button toggled from
// a stale value, so a second click was lost). `pending` is what each control
// overlays on its committed value.
//
// `navigate` is the transition the push runs in, so the caller's isPending
// covers the whole navigation; `navigating` is that isPending.
export function usePendingFilters(navigate: (cb: () => void) => void, navigating: boolean) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const committed = searchParams.toString();

  const pendingRef = useRef<PendingDelta>({});
  // The queries this bar pushed whose deltas are still in flight. A committed
  // URL outside this set came from somewhere else (reconcilePending).
  const pushedRef = useRef<Set<string>>(new Set());
  const [pending, setPendingState] = useState<PendingDelta>({});
  const setPending = useCallback((next: PendingDelta) => {
    pendingRef.current = next;
    setPendingState(next);
  }, []);

  // Drop the deltas the URL has caught up with; anything still in flight
  // stays. A URL this bar did not push voids them all.
  useEffect(() => {
    const next = reconcilePending(pendingRef.current, committed, pushedRef.current);
    pushedRef.current = next.pushed;
    if (next.pending !== pendingRef.current) setPending(next.pending);
  }, [committed, setPending]);

  // The transition ended. A delta the URL caught up with was dropped above; one
  // still here belongs to a navigation that never committed (the viewer
  // clicked a link to this same URL before it landed), so the committed query
  // never changed and nothing else would clear it: the bar kept showing the
  // filter over an unfiltered grid and re-applied it on the next change.
  useEffect(() => {
    if (navigating) return;
    pushedRef.current = new Set();
    if (Object.keys(pendingRef.current).length > 0) setPending({});
  }, [navigating, setPending]);

  // Back/forward replaces the query string wholesale, so any delta is void —
  // without this it would be reapplied on the next filter change and silently
  // undo the user's Back.
  useEffect(() => {
    const onPop = () => {
      pushedRef.current = new Set();
      setPending({});
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [setPending]);

  const push = useCallback((updates: PendingDelta) => {
    const next = { ...pendingRef.current, ...updates };
    const params = withPending(searchParams.toString(), next);
    // Any filter change invalidates the page number — the result set it
    // indexed into no longer exists.
    params.delete("page");
    const qs = params.toString();
    pushedRef.current.add(canonicalQuery(qs));
    setPending(next);
    navigate(() => router.push(qs ? `${pathname}?${qs}` : pathname));
  }, [router, pathname, searchParams, navigate, setPending]);

  // Clearing drops every param rather than editing some. The delta becomes
  // "remove each committed param", replacing whatever was in flight: the
  // controls show the cleared state at once, and a change made before the
  // clear lands builds on the cleared URL instead of resurrecting the filters.
  const clearAll = useCallback(() => {
    const next: PendingDelta = {};
    for (const key of new URLSearchParams(searchParams.toString()).keys()) next[key] = undefined;
    for (const key of Object.keys(pendingRef.current)) next[key] = undefined;
    pushedRef.current = new Set([canonicalQuery("")]);
    setPending(next);
    navigate(() => router.push(pathname));
  }, [router, pathname, searchParams, navigate, setPending]);

  return { pending, push, clearAll };
}
