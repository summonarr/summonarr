// Skeletons for the admin Activity DETAIL routes (media/[tmdbId], user/[id],
// play/[id]). They render a DetailHeader — back link, leading poster/avatar,
// title + subtitle — and no tab strip or filter segments, so the section-level
// admin/activity/loading.tsx (which draws both) made every detail navigation
// jump. The three bodies differ, so each route gets its own variant:
//   - TitleDetailSkeleton  (activity-title-detail.tsx): 56×84 poster, an
//     "Open in library" chip row, the HeaderStats right slot (3 × label over a
//     20px value, gap 24), then a full-width ~200px "Plays per day" card, a
//     resp-grid-3 row (1.4fr 1fr 1fr), a resp-grid-2 row and the plays table.
//   - UserDetailSkeleton   (activity-user-detail.tsx): 48px avatar, then the
//     repeat(5,1fr) resp-grid-3 MiniKpi grid (gap 10, ~80px tiles), the
//     365-day calendar card and the 1.2fr/1fr chart + heatmap row.
//   - PlayDetailSkeleton   (play/[id]/page.tsx): the max-w-4xl wrapper, poster
//     + a 16px watched/complete chip row, the md:grid-cols-3 gap-4 ~300px card
//     row (mb-6) and the right-aligned delete button — no trailing big card.
// Every row uses the page's own responsive classes (resp-grid-2/3 reflow at
// 1180 / 899 / 639 in globals.css) so the streamed page lands on the same grid.
import type { ReactNode } from "react";
import { Bar, SKELETON_CARD } from "@/components/loading/poster-grid-skeleton";

// ActivityCard stand-in: radius 10, the card hairline, a fixed height.
function Card({ h }: { h: number }) {
  return <Bar w="100%" h={h} r={10} style={SKELETON_CARD} />;
}

// DetailHeader stand-in: the back link's 24px line box (mb 14), then
// .ds-page-header (mb 22) with the leading media beside the title's 27px line
// box (22px × 1.2), the 12px subtitle's 18px line box (mt-1) and an optional
// children row (mt 10), plus the optional right slot.
function DetailHeaderSkeleton({
  leading,
  childRow,
  right,
}: {
  leading: "poster" | "avatar";
  childRow?: number;
  right?: ReactNode;
}) {
  return (
    <>
      <div className="flex items-center" style={{ height: 24, marginBottom: 14 }}>
        <Bar w={120} h={16} r={6} />
      </div>
      <div className="ds-page-header" style={{ marginBottom: 22 }}>
        <div className="flex-1 min-w-0 flex items-center" style={{ gap: 14 }}>
          {leading === "poster" ? <Bar w={56} h={84} r={5} /> : <Bar w={48} h={48} r={999} />}
          <div className="flex-1 min-w-0">
            <div className="flex items-center" style={{ height: 27 }}>
              <Bar w="45%" h={22} />
            </div>
            <div className="flex items-center mt-1" style={{ height: 18 }}>
              <Bar w="60%" h={12} />
            </div>
            {childRow != null && (
              <div className="flex items-center" style={{ height: childRow, marginTop: 10 }}>
                <Bar w={childRow > 20 ? 124 : 150} h={childRow > 20 ? childRow : 12} r={6} />
              </div>
            )}
          </div>
        </div>
        {right && <div className="ds-page-header-actions flex gap-1.5 flex-wrap">{right}</div>}
      </div>
    </>
  );
}

// HeaderStat × 3: a 14px mono label line, gap 3, a 20px (lineHeight 1) value.
function HeaderStatsSkeleton() {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "auto auto auto", gap: 24 }}>
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="flex flex-col items-end" style={{ gap: 3 }}>
          <div className="flex items-center" style={{ height: 14 }}>
            <Bar w={44} h={9} />
          </div>
          <Bar w={52} h={20} />
        </div>
      ))}
    </div>
  );
}

export function TitleDetailSkeleton() {
  return (
    <div className="animate-pulse">
      <DetailHeaderSkeleton leading="poster" childRow={32} right={<HeaderStatsSkeleton />} />
      <div style={{ marginBottom: 22 }}>
        <Card h={200} />
      </div>
      <div
        className="resp-grid-3"
        style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr 1fr", gap: 10, marginBottom: 22 }}
      >
        {Array.from({ length: 3 }).map((_, i) => (
          <Card key={i} h={220} />
        ))}
      </div>
      <div
        className="resp-grid-2"
        style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 22 }}
      >
        <Card h={180} />
        <Card h={180} />
      </div>
      <Card h={320} />
    </div>
  );
}

export function UserDetailSkeleton() {
  return (
    <div className="animate-pulse">
      <DetailHeaderSkeleton leading="avatar" />
      <div
        className="resp-grid-3"
        style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 10, marginBottom: 22 }}
      >
        {Array.from({ length: 5 }).map((_, i) => (
          <Card key={i} h={80} />
        ))}
      </div>
      <div style={{ marginBottom: 22 }}>
        <Card h={204} />
        {/* ActivityCalendar's sm:hidden "scroll for more" hint (+22px on phones) */}
        <div className="sm:hidden" style={{ height: 22 }} />
      </div>
      <div
        className="resp-grid-2"
        style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr", gap: 10, marginBottom: 22 }}
      >
        <Card h={200} />
        <Card h={200} />
      </div>
    </div>
  );
}

export function PlayDetailSkeleton() {
  return (
    <div className="animate-pulse max-w-4xl">
      <DetailHeaderSkeleton leading="poster" childRow={16} />
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        {Array.from({ length: 3 }).map((_, i) => (
          <Card key={i} h={300} />
        ))}
      </div>
      <div className="flex justify-end">
        <Bar w={92} h={30} r={8} style={SKELETON_CARD} />
      </div>
    </div>
  );
}
