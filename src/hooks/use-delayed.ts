"use client";

import { useEffect, useState } from "react";

export type Delayed = ((fn: () => void, ms: number) => void) & { cancel: () => void };

function createDelayed(): Delayed {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return Object.assign((fn: () => void, ms: number) => {
    cancel();
    timer = setTimeout(fn, ms);
  }, { cancel });
}

/**
 * `later(fn, ms)` runs `fn` after `ms`, replacing any earlier pending call and
 * cancelling it on unmount — so "clear the toast after 2s" timers never set
 * state on an unmounted component or stack up on repeat clicks.
 * `later.cancel()` drops the pending call: an action calls it when it starts,
 * so the previous run's reset can't fire into the new one.
 */
export function useDelayed(): Delayed {
  const [later] = useState(createDelayed);
  useEffect(() => later.cancel, [later]);
  return later;
}
