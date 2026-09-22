// Skeleton for My Stats: PageHeader with subtitle, the Year-in-Review banner,
// then MyStatsView — the 4-up MiniKpi tiles (minmax(150px,1fr); a 14px label
// line box over the 22px value's 33px line box, gap 4), the ~204px 365-day
// calendar card (+22px on phones for ActivityCalendar's sm:hidden scroll
// hint), and the minmax(280px,1fr) grid of ~220px chart cards.
import { Bar, SKELETON_CARD, SkeletonHeader } from "@/components/loading/poster-grid-skeleton";

export default function Loading() {
  const card = { ...SKELETON_CARD, borderRadius: 10, padding: 18 };
  return (
    <div className="animate-pulse">
      <SkeletonHeader subtitle />
      <div>
        <Bar w="100%" h={52} r={12} style={{ marginBottom: 22 }} />
        <div className="flex flex-col" style={{ gap: 22 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex flex-col" style={{ ...SKELETON_CARD, borderRadius: 10, padding: "14px 16px", gap: 4 }}>
                <div className="flex items-center" style={{ height: 14 }}>
                  <Bar w={70} h={10} />
                </div>
                <div className="flex items-center" style={{ height: 33 }}>
                  <Bar w={90} h={24} />
                </div>
              </div>
            ))}
          </div>
          <div style={card}>
            <Bar w={120} h={12} />
            <div className="sm:hidden" style={{ height: 22 }} />
            <Bar w="100%" h={136} style={{ marginTop: 18 }} />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 10 }}>
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} style={{ ...card, height: 220 }}>
                <Bar w={140} h={12} />
                <Bar w="100%" h={130} style={{ marginTop: 22 }} />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
