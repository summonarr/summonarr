"use client";

import type { CSSProperties, ReactNode } from "react";
import { PlayCircle, MonitorPlay, Clock, CheckCircle, type IconComponent } from "@/components/icons";
import type { TmdbMedia } from "@/lib/tmdb-types";
import { useT } from "@/components/i18n/i18n-provider";
import type { Translator } from "@/lib/i18n/translate";
import { availabilityChips, type AvailabilityChipKind, type AvailabilityChipOptions, type AvailabilityFlags } from "./availability-rules";

const CHIP_PAD = { paddingLeft: 5, paddingRight: 6 } as const;
const FOUR_K_STYLE: CSSProperties = {
  background: "var(--ds-accent-soft)",
  color: "var(--ds-accent-text)",
  border: "1px solid var(--ds-accent-ring)",
};

const CHIP_CLASS: Record<AvailabilityChipKind, string> = {
  plex: "ds-chip ds-chip-plex",
  jellyfin: "ds-chip ds-chip-jellyfin",
  fourK: "ds-chip",
  queued: "ds-chip ds-chip-pending",
  queued4k: "ds-chip ds-chip-pending",
  requested: "ds-chip ds-chip-accent",
};

const CHIP_ICON: Record<AvailabilityChipKind, IconComponent> = {
  plex: PlayCircle,
  jellyfin: MonitorPlay,
  fourK: CheckCircle,
  queued: Clock,
  queued4k: Clock,
  requested: CheckCircle,
};

// "compact" is the card / hero chip (brand names as written, a tight pad);
// "full" is the detail page's badge ("On Plex", "4K available").
type ChipVariant = "compact" | "full";

function chipLabel(kind: AvailabilityChipKind, variant: ChipVariant, t: Translator): ReactNode {
  switch (kind) {
    case "plex":
      return variant === "compact" ? "Plex" : t("media.badge.onPlex");
    case "jellyfin":
      return variant === "compact" ? "Jellyfin" : t("media.badge.onJellyfin");
    case "fourK":
      return variant === "compact" ? "4K" : t("media.badge.available4k");
    case "queued":
      return t("media.badge.queued");
    case "queued4k":
      return t("media.badge.queued4k");
    case "requested":
      return t("media.badge.requested");
  }
}

/** The chips themselves, as siblings for the caller's own container. One renderer for both variants. */
export function AvailabilityChipList({
  flags,
  variant,
  ...options
}: AvailabilityChipOptions & { flags: AvailabilityFlags; variant: ChipVariant }) {
  const t = useT();
  const iconSize = variant === "compact" ? 9 : 10;
  return (
    <>
      {availabilityChips(flags, options).map((kind) => {
        const Icon = CHIP_ICON[kind];
        const pad = variant === "compact" ? CHIP_PAD : undefined;
        const style = kind === "fourK" ? { ...pad, ...FOUR_K_STYLE } : pad;
        return (
          <span key={kind} className={CHIP_CLASS[kind]} style={style}>
            <Icon style={{ width: iconSize, height: iconSize }} />
            {chipLabel(kind, variant, t)}
          </span>
        );
      })}
    </>
  );
}

// The availability chips MediaCard and DiscoverHero show, as siblings for the
// caller's own container: Plex / Jellyfin (only the servers this viewer sees),
// 4K, Queued, Queued 4K, and optionally Requested. `isAvailable` is the
// caller's "available to this viewer" reading (isVisiblyAvailable), which
// suppresses Queued and Requested. The rules are availability-rules.ts, shared
// with the detail page's AvailabilityBadges.
export function AvailabilityChips({
  media,
  showPlex,
  showJellyfin,
  isAvailable,
  queuedBefore4k = false,
  showRequested = false,
}: {
  media: Pick<TmdbMedia, "plexAvailable" | "jellyfinAvailable" | "arrPending" | "arr4kAvailable" | "arr4kPending" | "requested">;
  showPlex: boolean;
  showJellyfin: boolean;
  isAvailable: boolean;
  /** The hero lists Queued before 4K; the card lists 4K first. */
  queuedBefore4k?: boolean;
  /** The hero's "Requested" chip (the card shows request state elsewhere). */
  showRequested?: boolean;
}) {
  return (
    <AvailabilityChipList
      flags={media}
      variant="compact"
      showPlex={showPlex}
      showJellyfin={showJellyfin}
      isAvailable={isAvailable}
      queuedBefore4k={queuedBefore4k}
      showRequested={showRequested}
    />
  );
}
