// Skeleton for the TV discovery grid (cold TMDB multi-page fan-out on first
// load). Shape: PageHeader, BrowseGrid's "N results" line, the FilterBar (sort
// segments + a row of selects = 2 control rows), then the .ds-media-grid.
import { PosterGridSkeleton } from "@/components/loading/poster-grid-skeleton";

export default function Loading() {
  return <PosterGridSkeleton subtitle controls={2} />;
}
