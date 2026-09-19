// Loading skeleton for the movie detail page — the route fetches TMDB details
// + credits + suggestions + several Prisma lookups before render. Same shell
// as the page: ds-detail-bleed so the backdrop runs edge to edge, the
// aspect-video backdrop fading into the page, the 160px poster + title block
// in ds-detail-body, then the cast grid.
import { CastSectionSkeleton, DetailHeroSkeleton } from "@/components/loading/poster-grid-skeleton";

export default function Loading() {
  return (
    <div className="ds-detail-bleed animate-pulse">
      <DetailHeroSkeleton />
      <CastSectionSkeleton />
    </div>
  );
}
