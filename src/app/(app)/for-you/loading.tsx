// Skeleton for the For You grid while the stored shelf is re-filtered against
// the viewer's current state. Shape: PageHeader with subtitle, the three
// PillFilter groups (type / show / sort — one or two wrapped rows on desktop,
// so 2 control rows), then the .ds-media-grid of recommendation cards.
import { PosterGridSkeleton } from "@/components/loading/poster-grid-skeleton";

export default function Loading() {
  return <PosterGridSkeleton subtitle controls={2} />;
}
