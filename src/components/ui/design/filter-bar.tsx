"use client";

import { cn } from "@/lib/utils";
import { SEGMENTED_TRACK_STYLE, segmentedItemStyle } from "./segmented-style";
import { SegmentCount } from "./segment-count";

export type FilterSegment<V extends string = string> = {
  value: V;
  label: React.ReactNode;
  count?: number;
};

export function FilterBar<V extends string = string>({
  segments,
  active,
  onChange,
  right,
  label,
  className,
}: {
  segments: readonly FilterSegment<V>[];
  active: V;
  onChange: (value: V) => void;
  right?: React.ReactNode;
  /** What the segments choose (e.g. "Status"), so a screen reader hears it
   *  with each toggle. */
  label?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 mb-4 flex-wrap",
        className,
      )}
    >
      <div
        role="group"
        aria-label={label}
        className="ds-no-scrollbar flex overflow-x-auto max-w-full"
        style={SEGMENTED_TRACK_STYLE}
      >
        {segments.map((s) => {
          const isActive = s.value === active;
          return (
            <button
              key={s.value}
              type="button"
              onClick={() => onChange(s.value)}
              aria-pressed={isActive}
              // min-h-9 (36px) on phones, 32px from sm: these are the main
              // filter controls on list pages, packed into a scrolling track.
              className="ds-hover-tint inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 font-medium border-0 min-h-9 sm:min-h-8"
              style={segmentedItemStyle(isActive)}
            >
              {s.label}
              {typeof s.count === "number" && <SegmentCount isActive={isActive}>{s.count}</SegmentCount>}
            </button>
          );
        })}
      </div>
      <div className="flex-1" />
      {right}
    </div>
  );
}
