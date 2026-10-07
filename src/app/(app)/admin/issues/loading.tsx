// Skeleton for admin → Issues. Mirrors issues/page.tsx: PageHeader with its
// (wrapping) subtitle → the four status tabs in one bordered strip (mb 20) →
// the xl two-pane grid (`1fr 480px`, gap 6): issue cards (~88px: p-4 around a
// 56px poster, gap 12) on the left and the sticky side panel on the right,
// which below xl is hidden exactly like the real aside. The generic subtree
// skeleton used to stand in here and offered no two-pane placeholder.
import { SKELETON_CARD, SkeletonHeader } from "@/components/loading/poster-grid-skeleton";
import { AdminCardRowsSkeleton, AdminPillGroupSkeleton } from "@/components/loading/admin-skeleton";

export default function Loading() {
  return (
    <div className="animate-pulse">
      <SkeletonHeader subtitle subtitleLines={2} />

      <div style={{ marginBottom: 20 }}>
        <AdminPillGroupSkeleton widths={[76, 110, 96, 60]} />
      </div>

      <div className="xl:grid xl:grid-cols-[1fr_480px] xl:gap-6 xl:items-start">
        <div className="min-w-0">
          <AdminCardRowsSkeleton rows={5} height={88} gap={12} />
        </div>
        <aside className="hidden xl:block sticky top-6 h-[calc(100dvh-52px-3rem)]">
          <div className="h-full" style={{ ...SKELETON_CARD, borderRadius: 8 }} />
        </aside>
      </div>
    </div>
  );
}
