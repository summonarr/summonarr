// Detail-shaped fallback — see activity-detail-skeleton.tsx for why this route
// doesn't inherit the tabbed section skeleton in admin/activity/loading.tsx,
// and for the activity-user-detail.tsx layout it mirrors.
import { UserDetailSkeleton } from "@/components/loading/activity-detail-skeleton";

export default function Loading() {
  return <UserDetailSkeleton />;
}
