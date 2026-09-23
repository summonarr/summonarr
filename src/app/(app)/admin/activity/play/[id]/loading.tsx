// Detail-shaped fallback — see activity-detail-skeleton.tsx for why this route
// doesn't inherit the tabbed section skeleton in admin/activity/loading.tsx,
// and for the play/[id]/page.tsx layout it mirrors.
import { PlayDetailSkeleton } from "@/components/loading/activity-detail-skeleton";

export default function Loading() {
  return <PlayDetailSkeleton />;
}
