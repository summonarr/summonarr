import Link from "next/link";
import { SEGMENTED_TRACK_STYLE, segmentedItemStyle } from "./segmented-style";

export type SegmentedLink = {
  key: string;
  label: React.ReactNode;
  href: string;
};

// The design-system FilterBar's segmented control, for segments that are LINKS
// (a server page whose state lives in the URL) rather than buttons. The track
// and the raised active segment come from segmented-style.ts, shared with it.
export function SegmentedLinks({
  links,
  active,
}: {
  links: readonly SegmentedLink[];
  active: string;
}) {
  return (
    <div
      className="ds-no-scrollbar flex overflow-x-auto max-w-full"
      style={SEGMENTED_TRACK_STYLE}
    >
      {links.map((l) => {
        const isActive = l.key === active;
        return (
          <Link
            key={l.key}
            href={l.href}
            aria-current={isActive ? "page" : undefined}
            className="ds-hover-tint inline-flex items-center whitespace-nowrap shrink-0 font-medium"
            style={{
              // 32px hit area: on a page whose only controls these are, 5px
              // padding alone left them ~26px tall at phone width.
              minHeight: 32,
              ...segmentedItemStyle(isActive),
            }}
          >
            {l.label}
          </Link>
        );
      })}
    </div>
  );
}
