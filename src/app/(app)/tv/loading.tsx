// Skeleton for the TV discovery grid. Cold TMDB multi-page fan-out on first
// load — show a skeleton instead of blocking navigation.
import { PosterGridSkeleton } from "@/components/loading/poster-grid-skeleton";

export default function Loading() {
  return <PosterGridSkeleton title="TV Shows" />;
}
