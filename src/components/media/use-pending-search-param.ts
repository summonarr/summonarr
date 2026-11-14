"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { holdPendingQuery, nextPendingQuery, settlePendingQuery } from "@/lib/client/pending-query";

// One URL search param as client state for a pill / toggle whose page
// re-enriches its whole set on every change, so a click can take a moment to
// land. `shown` is the value to draw: the chosen one straight away while the
// navigation is pending, else the committed `active`. A change must derive its
// next value from `shown`, never from `active` — a second click while the
// first is pending reads the stale committed prop and would push the same URL.
// Every change drops `page`: the page it indexed into means nothing for the
// new set.
//
// A page can hold several of these (the three /for-you pill groups), each its
// own hook instance, and `searchParams` is the COMMITTED url. So the changes
// still in flight are shared between them: a second group clicked before the
// first navigation lands builds on the first group's change instead of the
// stale URL, which dropped it (use-pending-filters.ts solves the same thing
// for the filter bars). The carried changes apply only to the committed query
// they were made against, and are dropped as soon as the URL moves or the last
// pending navigation ends without moving it (src/lib/client/pending-query.ts).
export function usePendingSearchParam<V extends string>(param: string, active: V | undefined) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const [pendingValue, setPendingValue] = useState<{ v: V | undefined } | null>(null);
  const shown = isPending && pendingValue ? pendingValue.v : active;
  const committed = searchParams.toString();

  useEffect(() => {
    settlePendingQuery(pathname, committed);
  }, [pathname, committed]);

  // While this hook's navigation is pending the carried changes are held;
  // they go when the last pending one ends or unmounts (holdPendingQuery).
  useEffect(() => {
    if (!isPending) return;
    return holdPendingQuery();
  }, [isPending]);

  /** undefined clears the param. */
  function set(value: V | undefined) {
    const qs = nextPendingQuery(pathname, committed, param, value);
    setPendingValue({ v: value });
    startTransition(() => {
      router.push(qs ? `${pathname}?${qs}` : pathname);
    });
  }

  return { shown, set, isPending };
}
