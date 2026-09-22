// Skeleton for Year in Review: the "Back to My Stats" link (an inline-flex
// sitting in its parent's 24px line box, mb 14), PageHeader with subtitle,
// then WrappedView — the gradient hero (kicker / title / totals label line
// boxes of 16.5 / 45 / 16px around the 38px lineHeight-1 totals), the #1
// spotlight card (70×104 poster) and the minmax(200px,1fr) stat-card grid.
// No year pills: the page renders them only when there's more than one year,
// and a single-year account is the common case. Bars inside the filled
// hero/stat cards use a translucent fg mix so they read in both themes.
import { Bar, SKELETON_CARD, SKELETON_FILL, SkeletonHeader } from "@/components/loading/poster-grid-skeleton";

const INNER = "color-mix(in oklab, var(--ds-fg) 8%, transparent)";

export default function Loading() {
  return (
    <div className="animate-pulse">
      <div className="flex items-center" style={{ height: 24, marginBottom: 14 }}>
        <Bar w={120} h={13} />
      </div>
      <SkeletonHeader subtitle />
      <div className="flex flex-col" style={{ gap: 20 }}>
        {/* Hero */}
        <div style={{ borderRadius: 18, padding: "30px 26px", background: SKELETON_FILL }}>
          <div className="flex items-center" style={{ height: 16.5 }}>
            <Bar w={110} h={11} style={{ background: INNER }} />
          </div>
          <div className="flex items-center" style={{ height: 45, marginTop: 6, marginBottom: 20 }}>
            <Bar w={260} h={30} style={{ background: INNER, maxWidth: "100%" }} />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 16 }}>
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i}>
                <Bar w={72} h={38} style={{ background: INNER }} />
                <div className="flex items-center" style={{ height: 16, marginTop: 6 }}>
                  <Bar w={90} h={10} style={{ background: INNER }} />
                </div>
              </div>
            ))}
          </div>
        </div>
        {/* #1 spotlight */}
        <div className="flex items-center" style={{ ...SKELETON_CARD, gap: 18, borderRadius: 14, padding: 18 }}>
          <Bar w={70} h={104} r={6} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center" style={{ height: 16 }}>
              <Bar w={120} h={10} />
            </div>
            <div className="flex items-center" style={{ height: 33, margin: "4px 0 6px" }}>
              <Bar w={240} h={22} style={{ maxWidth: "100%" }} />
            </div>
            <div className="flex items-center" style={{ height: 19 }}>
              <Bar w={150} h={12} />
            </div>
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
