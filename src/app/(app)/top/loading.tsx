// Skeleton for the Top grid while TMDB + rating-source lookups run.
import { PosterGridSkeleton } from "@/components/loading/poster-grid-skeleton";

export default function Loading() {
  return <PosterGridSkeleton title="Top rated" subtitle="Highest-rated picks from your enabled sources" />;
}
