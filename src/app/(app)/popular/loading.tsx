// Skeleton for the Popular grid while the play-history aggregate + TMDB
// detail resolution run. Mirrors the page's PageHeader (popular/page.tsx) so
// the header text does not swap once the real content arrives.
import { PosterGridSkeleton } from "@/components/loading/poster-grid-skeleton";

export default function Loading() {
  return <PosterGridSkeleton title="Popular on Server" subtitle="Most played on your servers" />;
}
