// Skeleton for the Upcoming grid while TMDB + cache lookups run. Shape:
// PageHeader with subtitle and the hide-available toggle on the right (no
// filter rows), then the .ds-media-grid.
import { PosterGridSkeleton } from "@/components/loading/poster-grid-skeleton";

export default function Loading() {
  return <PosterGridSkeleton subtitle right controls={0} />;
}
