// Skeleton for the Movies discovery grid. This page does a cold TMDB multi-page
// fan-out on first load, so without a loading state the navigation blocks with
// no feedback.
import { PosterGridSkeleton } from "@/components/loading/poster-grid-skeleton";

export default function Loading() {
  return <PosterGridSkeleton title="Movies" />;
}
