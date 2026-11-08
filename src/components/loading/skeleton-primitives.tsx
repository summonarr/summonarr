// The skeleton kit's primitives: the root every skeleton renders, the bar,
// the card surface, the page-header stand-in and the 32px control row. The
// poster layouts (poster-grid-skeleton.tsx) and the admin / activity skeletons
// all compose these, as do the (app) loading.tsx files.
//
// Fills are --ds-bg-3 throughout: --ds-bg-2 is pure white in light mode and a
// block filled with it is invisible on the --ds-bg page. Card containers use
// --ds-bg-1 + a hairline for the same reason.
import type { CSSProperties, ReactNode } from "react";
import { SkeletonLoadingLabel } from "@/components/loading/skeleton-label";

export const SKELETON_FILL = "var(--ds-bg-3)";
export const SKELETON_CARD: CSSProperties = {
  background: "var(--ds-bg-1)",
  border: "1px solid var(--ds-border)",
};

// The root of every skeleton (loading.tsx boundaries and the kit's page-level
// skeletons): the pulse plus what assistive tech needs — a status region that
// is busy, named by a translated, visually hidden "Loading…". The bars are
// empty boxes with nothing to read. The label is the FIRST child and sr-only
// (absolutely positioned), so it takes no space and the no-reflow footprint
// holds. Never nest one inside another: a skeleton has one status.
export function SkeletonRoot({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div role="status" aria-busy="true" className={className ? `${className} animate-pulse` : "animate-pulse"}>
      <SkeletonLoadingLabel />
      {children}
    </div>
  );
}

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

// A segmented-control / pill-group stand-in: the 32px bordered box the
// design-system FilterBar and FilterPills render.
export function ControlRow({ w = 280 }: { w?: number | string }) {
  return <Bar w={w} h={32} r={8} style={{ ...SKELETON_CARD, maxWidth: "100%" }} />;
}
