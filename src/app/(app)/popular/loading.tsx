// Skeleton for the Popular grid while TMDB + cache lookups run.
import { PosterGridSkeleton } from "@/components/loading/poster-grid-skeleton";

export default function Loading() {
  return <PosterGridSkeleton title="Popular" subtitle="Trending on TMDB right now" />;
}
