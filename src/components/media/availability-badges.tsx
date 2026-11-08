"use client";

// Client component only so it can read the UI translator; every caller is a
// server page passing plain booleans. The rules are availability-rules.ts and
// the chips AvailabilityChipList, shared with the cards and the Discover hero.
import { cn } from "@/lib/utils";
import { AvailabilityChipList } from "./availability-chips";
import { availabilityChips, isVisiblyAvailable } from "./availability-rules";

export interface AvailabilityBadgesProps {
  plexAvailable?: boolean;
  jellyfinAvailable?: boolean;
  arrPending?: boolean;
  requested?: boolean;
  // 4K-instance state — only rendered when show4k is true (viewer has 4K access).
  arr4kAvailable?: boolean;
  arr4kPending?: boolean;
  showPlex: boolean;
  showJellyfin: boolean;
  show4k?: boolean;
  className?: string;
}

export function AvailabilityBadges({ showPlex, showJellyfin, show4k, className, ...flags }: AvailabilityBadgesProps) {
  const options = {
    showPlex,
    showJellyfin,
    show4k: !!show4k,
    isAvailable: isVisiblyAvailable(flags, showPlex, showJellyfin),
    showRequested: true,
  };
  if (availabilityChips(flags, options).length === 0) return null;
  return (
    <div className={cn("flex flex-wrap items-center gap-1", className)}>
      <AvailabilityChipList flags={flags} variant="full" {...options} />
    </div>
  );
}
