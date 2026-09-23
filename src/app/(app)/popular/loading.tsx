// Skeleton for the Popular grid while the play-history aggregate + TMDB detail
// resolution run. Shape: PageHeader with subtitle, the one sort/type pill row,
// then the ranked .ds-media-grid.
import { PosterGridSkeleton } from "@/components/loading/poster-grid-skeleton";

export default function Loading() {
  return <PosterGridSkeleton subtitle controls={1} />;
}
