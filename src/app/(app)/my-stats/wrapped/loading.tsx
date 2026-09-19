// Skeleton for Year in Review: the "Back to My Stats" link, PageHeader with
// subtitle, the year pills, then WrappedView — the gradient hero (kicker,
// title, three big totals), the #1 spotlight card (70×104 poster) and the
// minmax(200px,1fr) stat-card grid. Bars inside the filled hero/stat cards use
// a translucent fg mix so they read in both themes.
import { Bar, SKELETON_CARD, SKELETON_FILL, SkeletonHeader } from "@/components/loading/poster-grid-skeleton";

const INNER = "color-mix(in oklab, var(--ds-fg) 8%, transparent)";

export default function Loading() {
  return (
    <div className="animate-pulse">
      <Bar w={120} h={13} style={{ marginBottom: 14 }} />
      <SkeletonHeader subtitle />
      <div className="flex flex-wrap" style={{ gap: 8, marginTop: 14 }}>
        {Array.from({ length: 3 }).map((_, i) => (
          <Bar key={i} w={56} h={28} r={999} />
        ))}
      </div>
      <div className="flex flex-col" style={{ marginTop: 18, gap: 20 }}>
        {/* Hero */}
        <div style={{ borderRadius: 18, padding: "30px 26px", background: SKELETON_FILL }}>
          <Bar w={110} h={11} style={{ background: INNER }} />
          <Bar w={260} h={30} style={{ background: INNER, marginTop: 6, marginBottom: 20, maxWidth: "100%" }} />
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 16 }}>
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i}>
                <Bar w={72} h={38} style={{ background: INNER }} />
                <Bar w={90} h={10} style={{ background: INNER, marginTop: 6 }} />
              </div>
            ))}
          </div>
        </div>
        {/* #1 spotlight */}
        <div className="flex items-center" style={{ ...SKELETON_CARD, gap: 18, borderRadius: 14, padding: 18 }}>
          <Bar w={70} h={104} r={6} />
          <div className="min-w-0 flex flex-col" style={{ gap: 6 }}>
            <Bar w={120} h={10} />
            <Bar w={240} h={22} style={{ maxWidth: "100%" }} />
            <Bar w={150} h={12} />
          </div>
        </div>
        {/* Stat cards */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="flex flex-col justify-between"
              style={{ borderRadius: 14, padding: "18px 18px 20px", minHeight: 128, background: SKELETON_FILL }}
            >
              <Bar w={90} h={10} style={{ background: INNER }} />
              <div className="flex flex-col" style={{ gap: 6 }}>
                <Bar w="70%" h={22} style={{ background: INNER }} />
                <Bar w="45%" h={12} style={{ background: INNER }} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
