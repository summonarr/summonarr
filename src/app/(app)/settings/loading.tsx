// Skeleton for the admin Settings page. The page aggregates many Setting reads
// plus live Plex/Jellyfin status probes before render, so a fallback keeps the
// navigation feeling immediate. Shape mirrors settings/page.tsx: PageHeader
// with subtitle, SettingsTabNav — ONE bordered, wrapping group (padding 2,
// radius 8) of six 28px pills — then, 24px below, the `lg:flex lg:gap-8` body:
// the lg-only 192px (w-48) SettingsNav (group label + 32px links) beside the
// max-w-3xl column of section cards (padding 22, radius 10, gap 16), each
// opening with a 15px heading + 12px description (mb-5).
import { Bar, SKELETON_CARD, SkeletonHeader } from "@/components/loading/poster-grid-skeleton";

// Site / Media / Notifications / Integrations / Features / System at 12px with
// 14px side padding.
const TAB_WIDTHS = [54, 64, 108, 104, 82, 74];

export default function Loading() {
  return (
    <div className="animate-pulse">
      <SkeletonHeader subtitle />

      <div className="flex flex-wrap gap-1 max-w-full" style={{ ...SKELETON_CARD, padding: 2, borderRadius: 8 }}>
        {/* The active pill is filled; the rest are bare labels, like the nav. */}
        {TAB_WIDTHS.map((w, i) =>
          i === 0 ? (
            <Bar key={i} w={w} h={28} r={6} />
          ) : (
            <div key={i} className="flex items-center justify-center" style={{ width: w, height: 28 }}>
              <Bar w={w - 28} h={10} />
            </div>
          ),
        )}
      </div>

      <div className="lg:flex lg:gap-8" style={{ marginTop: 24 }}>
        <aside className="hidden lg:block w-48 shrink-0">
          <div className="flex items-center px-3 mb-1.5" style={{ height: 16 }}>
            <Bar w={64} h={9} />
          </div>
          <div className="space-y-0.5">
            {[96, 110, 70, 104, 116].map((w, i) => (
              <div key={i} className="flex items-center px-3" style={{ height: 32 }}>
                <Bar w={w} h={12} />
              </div>
            ))}
          </div>
        </aside>

        <div className="max-w-3xl flex-1 flex flex-col" style={{ gap: 16 }}>
          {[210, 170, 190, 150].map((h, i) => (
            <div key={i} style={{ ...SKELETON_CARD, padding: 22, borderRadius: 10, height: h }}>
              <div className="flex items-center" style={{ height: 22 }}>
                <Bar w={120} h={14} />
              </div>
              <div className="flex items-center" style={{ height: 18, marginTop: 4 }}>
                <Bar w={240} h={11} style={{ maxWidth: "100%" }} />
              </div>
              <Bar w="100%" h={36} r={8} style={{ marginTop: 20 }} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
