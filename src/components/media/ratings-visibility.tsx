"use client";

import { createContext, useContext } from "react";
import type { RatingSourceKey } from "@/lib/ratings-visibility";

// Client side of the per-source rating-badge visibility (see
// src/lib/ratings-visibility.ts for the source list + Setting parse). The (app)
// layout reads the `ratingsHiddenSources` Setting server-side and mounts this
// provider so every RatingsBar — detail pages, cards, admin request list —
// respects it without per-call-site prop threading.

const HiddenRatingSourcesContext = createContext<readonly RatingSourceKey[]>([]);

export function RatingsVisibilityProvider({
  hidden,
  children,
}: {
  hidden: readonly RatingSourceKey[];
  children: React.ReactNode;
}) {
  return (
    <HiddenRatingSourcesContext.Provider value={hidden}>
      {children}
    </HiddenRatingSourcesContext.Provider>
  );
}

export function useHiddenRatingSources(): readonly RatingSourceKey[] {
  return useContext(HiddenRatingSourcesContext);
}
