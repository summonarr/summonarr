"use client";

import { useState, useTransition } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";

// One URL search param as client state for a pill / toggle whose page
// re-enriches its whole set on every change, so a click can take a moment to
// land. `shown` is the value to draw: the chosen one straight away while the
// navigation is pending, else the committed `active`. A change must derive its
// next value from `shown`, never from `active` — a second click while the
// first is pending reads the stale committed prop and would push the same URL.
// Every change drops `page`: the page it indexed into means nothing for the
// new set.
export function usePendingSearchParam<V extends string>(param: string, active: V | undefined) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const [pendingValue, setPendingValue] = useState<{ v: V | undefined } | null>(null);
  const shown = isPending && pendingValue ? pendingValue.v : active;

  /** undefined clears the param. */
  function set(value: V | undefined) {
    const params = new URLSearchParams(searchParams.toString());
    if (value === undefined) params.delete(param);
    else params.set(param, value);
    params.delete("page");
    const qs = params.toString();
    setPendingValue({ v: value });
    startTransition(() => {
      router.push(qs ? `${pathname}?${qs}` : pathname);
    });
  }

  return { shown, set, isPending };
}
