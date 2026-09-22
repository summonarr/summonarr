// Shared skeleton kit. `PosterGridSkeleton` stands in for the MediaCard grids
// (movies / tv / upcoming / popular / top / for-you); the smaller exports are
// the pieces the other (app) loading.tsx files compose. Everything mirrors the
// real page's footprint — PageHeader's box, the controls row every grid page
// renders above the grid, `.ds-media-grid` itself (fixed 2–6 columns, not an
// auto-fill), and a MediaCard-shaped tile (2:3 poster + ~90px body, radius 8)
// — so the streamed page lands on the same layout with no reflow.
// Fills are --ds-bg-3 throughout: --ds-bg-2 is pure white in light mode and a
// block filled with it is invisible on the --ds-bg page. Card containers use
// --ds-bg-1 + a hairline for the same reason.
import type { CSSProperties } from "react";

export const SKELETON_FILL = "var(--ds-bg-3)";
export const SKELETON_CARD: CSSProperties = {
  background: "var(--ds-bg-1)",
  border: "1px solid var(--ds-border)",
};

// One text / control bar. `w` is a px number or any CSS width.
export function Bar({
  w,
  h = 14,
  r = 4,
  style,
}: {
  w: number | string;
  h?: number;
  r?: number;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{ width: w, height: h, borderRadius: r, background: SKELETON_FILL, flexShrink: 0, ...style }}
    />
  );
}

// PageHeader stand-in: the 22px title's 33px line box, the optional 12px
// subtitle (18px line box per line, mt-1), an optional right-aligned action,
// mb-5. `subtitleLines` covers pages whose long subtitle wraps (issues, votes).
// Booleans only — never literal text that could drift from the page.
export function SkeletonHeader({
  subtitle = false,
  subtitleLines = 1,
  right = false,
}: {
  subtitle?: boolean;
  subtitleLines?: number;
  right?: boolean;
}) {
  return (
    <div className="ds-page-header mb-5">
      <div className="flex-1 min-w-0">
        <div className="flex items-center" style={{ height: 33 }}>
          <Bar w={200} h={24} />
        </div>
        {subtitle && (
          <div className="mt-1">
            {Array.from({ length: subtitleLines }).map((_, i) => (
              <div key={i} className="flex items-center" style={{ height: 18 }}>
                <Bar
                  w={subtitleLines > 1 && i === subtitleLines - 1 ? 220 : 320}
                  h={12}
                  style={{ maxWidth: "100%" }}
                />
              </div>
            ))}
          </div>
        )}
      </div>
      {right && (
        <div className="ds-page-header-actions flex gap-1.5">
          <Bar w={120} h={32} r={8} />
        </div>
      )}
    </div>
  );
}

// A MediaCard-shaped tile: 2:3 poster over a ~90px body (two title lines +
// meta), radius 8 with the card's hairline.
export function MediaCardTile() {
  return (
    <div className="overflow-hidden rounded-lg" style={SKELETON_CARD}>
      <div className="aspect-[2/3] w-full" style={{ background: SKELETON_FILL }} />
      <div className="flex flex-col gap-1.5 p-3" style={{ height: 90 }}>
        <Bar w="82%" h={15} />
        <Bar w="58%" h={15} />
        <Bar w="42%" h={10} style={{ marginTop: 2 }} />
      </div>
    </div>
  );
}

// A segmented-control / pill-group stand-in: the 32px bordered box the
// design-system FilterBar and FilterPills render.
export function ControlRow({ w = 280 }: { w?: number | string }) {
  return <Bar w={w} h={32} r={8} style={{ ...SKELETON_CARD, maxWidth: "100%" }} />;
}

// Detail-page hero (movie + tv): the edge-to-edge backdrop (aspect-video,
// capped like the page) fading into the page, then .ds-detail-body /
// .ds-detail-hero with the 160px poster (hidden below sm, like the real one)
// beside chips, the 32px title, meta, genres, ratings, overview and the action
// buttons. Callers wrap it in `ds-detail-bleed` themselves.
export function DetailHeroSkeleton() {
  return (
    <>
      <div
        className="relative w-full overflow-hidden aspect-video max-h-[500px] xl:max-h-[640px] 2xl:max-h-[760px]"
        style={{ background: SKELETON_FILL }}
      >
        <div
          className="absolute inset-0"
          style={{
            background:
              "linear-gradient(to top, var(--ds-bg) 0%, color-mix(in oklab, var(--ds-bg) 55%, transparent) 55%, transparent 100%)",
          }}
        />
      </div>
      <div className="ds-detail-body">
        <div className="ds-detail-hero">
          <div
            className="ds-detail-poster hidden sm:block shrink-0 rounded-lg"
            style={{ width: 160, aspectRatio: "2 / 3", background: SKELETON_FILL, border: "1px solid var(--ds-border)" }}
          />
          <div className="flex flex-col justify-end" style={{ gap: 10 }}>
            <div className="flex" style={{ gap: 8 }}>
              <Bar w={52} h={20} r={999} />
              <Bar w={72} h={20} r={999} />
            </div>
            <Bar w="55%" h={32} />
            <Bar w="35%" h={12} />
            <div className="flex" style={{ gap: 6 }}>
              {Array.from({ length: 3 }).map((_, i) => (
                <Bar key={i} w={64} h={20} r={999} />
              ))}
            </div>
            <Bar w={240} h={20} />
            <div className="flex flex-col max-w-2xl" style={{ gap: 7 }}>
              <Bar w="100%" h={13} />
              <Bar w="92%" h={13} />
              <Bar w="64%" h={13} />
            </div>
            <div className="flex" style={{ gap: 10, marginTop: 6 }}>
              <Bar w={130} h={36} r={8} />
              <Bar w={110} h={36} r={8} />
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

// CastSection stand-in: section title + the same responsive avatar grid
// (56px circles, name + role lines) as cast-section.tsx.
export function CastSectionSkeleton({ count = 8 }: { count?: number }) {
  return (
    <section style={{ padding: "0 16px 32px" }}>
      <Bar w={60} h={18} style={{ marginBottom: 12 }} />
      <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 xl:grid-cols-12 2xl:grid-cols-16 gap-3">
        {Array.from({ length: count }).map((_, i) => (
          <div key={i} className="flex flex-col items-center" style={{ gap: 6, padding: 4 }}>
            <Bar w={56} h={56} r={999} />
            <Bar w={64} h={12} />
            <Bar w={44} h={10} />
          </div>
        ))}
      </div>
    </section>
  );
}

// The grid pages: header, `controls` rows of 32px control placeholders (the
// segment / pill / select rows each page renders, `flex-col gap-3`), then the
// `.ds-media-grid` of card tiles. 6 tiles per row = one row at the widest
// breakpoint; narrower viewports wrap exactly like the real grid.
export function PosterGridSkeleton({
  subtitle = false,
  right = false,
  controls = 1,
  rows = 3,
}: {
  subtitle?: boolean;
  right?: boolean;
  controls?: number;
  rows?: number;
}) {
  return (
    <div className="animate-pulse">
      <SkeletonHeader subtitle={subtitle} right={right} />
      {controls > 0 && (
        <div className="flex flex-col gap-3 mb-6">
          {Array.from({ length: controls }).map((_, i) => (
            <ControlRow key={i} />
          ))}
        </div>
      )}
      <div className="ds-media-grid">
        {Array.from({ length: rows * 6 }).map((_, i) => (
          <MediaCardTile key={i} />
        ))}
      </div>
    </div>
  );
}
