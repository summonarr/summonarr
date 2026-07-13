"use client";

import { createContext, useContext } from "react";

// Client side of the per-source rating-badge visibility (see
// src/lib/ratings-visibility.ts for the source list + Setting parse). The (app)
// layout reads the `ratingsHiddenSources` Setting server-side and mounts this
// provider so every RatingsBar — detail pages, cards, admin request list —
// respects it without per-call-site prop threading.

const HiddenRatingSourcesContext = createContext<readonly string[]>([]);

export function RatingsVisibilityProvider({
  hidden,
  children,
}: {
  hidden: readonly string[];
  children: React.ReactNode;
}) {
  return (
    <HiddenRatingSourcesContext.Provider value={hidden}>
      {children}
    </HiddenRatingSourcesContext.Provider>
  );
}

export function useHiddenRatingSources(): readonly string[] {
  return useContext(HiddenRatingSourcesContext);
}
