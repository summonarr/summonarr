// Skeleton for the Hidden list: PageHeader with subtitle, then HiddenGrid's
// auto-fill 140px grid of 2:3 poster tiles (radius 8 + hairline, dimmed like
// the real ones) with a one-line title under each.
import { Bar, SKELETON_FILL, SkeletonHeader } from "@/components/loading/poster-grid-skeleton";

export default function Loading() {
  return (
    <div className="animate-pulse">
      <SkeletonHeader subtitle />
      <div>
        <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))" }}>
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i}>
              <div
                style={{ aspectRatio: "2 / 3", borderRadius: 8, background: SKELETON_FILL, border: "1px solid var(--ds-border)", opacity: 0.75 }}
              />
              <Bar w="70%" h={12} style={{ marginTop: 8 }} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
