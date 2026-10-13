"use client";

// "Instant, then live" for an admin Radarr/Sonarr page (src/lib/arr-snapshot.ts):
// on open, paint the last answer the server kept for the page's read while the
// page's own live load is out, then let the live answer replace it.
//
// - `url` is the page's live read URL (null while there is nothing to read). A
//   new url (another tab, instance, page or window) reads its own snapshot.
// - `apply` is the page's usual setter for a live answer; it gets the snapshot's
//   data only while no live answer for this url has landed. It may return
//   `false` to decline (a write in flight, the view already filled) — then the
//   stale note is not shown either, since nothing stale is on screen.
// - The page calls `markLive()` whenever a live answer for the current url lands:
//   from then on a late snapshot is ignored and the stale note goes away.
// Display only — every action re-checks live on the server (guardrail 5e).
import { useCallback, useEffect, useRef, useState } from "react";
import { readArrSnapshot } from "@/lib/client/arr-snapshot";

export interface ArrSnapshotState {
  /** When the painted snapshot was read (ISO), or null when the page shows live data. */
  staleAt: string | null;
  markLive: () => void;
}

export function useArrSnapshot<T>(url: string | null, apply: (data: T) => boolean | void): ArrSnapshotState {
  const [shown, setShown] = useState<{ url: string; at: string } | null>(null);
  const liveFor = useRef<string | null>(null);
  const applyRef = useRef(apply);
  useEffect(() => {
    applyRef.current = apply;
  });

  useEffect(() => {
    if (!url) return;
    liveFor.current = null;
    const ctl = new AbortController();
    void readArrSnapshot<T>(url, { signal: ctl.signal }).then((snap) => {
      // A live answer that beat the snapshot always wins.
      if (!snap || ctl.signal.aborted || liveFor.current === url) return;
      if (applyRef.current(snap.data) === false) return;
      setShown({ url, at: snap.at });
    });
    return () => ctl.abort();
  }, [url]);

  const markLive = useCallback(() => {
    liveFor.current = url;
    setShown(null);
  }, [url]);

  return { staleAt: shown && shown.url === url ? shown.at : null, markLive };
}
