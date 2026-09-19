// Skeleton for the Top Rated grid while TMDB + rating-source lookups run.
// Shape: PageHeader with subtitle, the TopFilterBar (type segments + sort
// segments + a row of selects = 3 control rows), then the .ds-media-grid.
import { PosterGridSkeleton } from "@/components/loading/poster-grid-skeleton";

export default function Loading() {
  return <PosterGridSkeleton subtitle controls={3} />;
}
