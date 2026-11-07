"use client";

import { PlayCircle, MonitorPlay, Clock, CheckCircle } from "@/components/icons";
import type { TmdbMedia } from "@/lib/tmdb-types";
import { useT } from "@/components/i18n/i18n-provider";

const CHIP_PAD = { paddingLeft: 5, paddingRight: 6 } as const;

// The availability chips MediaCard and DiscoverHero show, as siblings for the
// caller's own container: Plex / Jellyfin (only the servers this viewer sees),
// Queued, 4K, Queued 4K, and optionally Requested. `isAvailable` is the
// caller's "available to this viewer" reading, which suppresses Queued and
// Requested. One copy, so a new badge or source lands in both places.
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
  const t = useT();
  const queued = !isAvailable && media.arrPending && (
    <span className="ds-chip ds-chip-pending" style={CHIP_PAD}>
      <Clock style={{ width: 9, height: 9 }} />
      {t("media.badge.queued")}
    </span>
  );
  // arr4k* are only populated when the viewer has 4K access (enrichment gate).
  const fourK = media.arr4kAvailable && (
    <span
      className="ds-chip"
      style={{
        ...CHIP_PAD,
        background: "var(--ds-accent-soft)",
        color: "var(--ds-accent-text)",
        border: "1px solid var(--ds-accent-ring)",
      }}
    >
      <CheckCircle style={{ width: 9, height: 9 }} />
      4K
    </span>
  );
  return (
    <>
      {showPlex && media.plexAvailable && (
        <span className="ds-chip ds-chip-plex" style={CHIP_PAD}>
          <PlayCircle style={{ width: 9, height: 9 }} />
          Plex
        </span>
      )}
      {showJellyfin && media.jellyfinAvailable && (
        <span className="ds-chip ds-chip-jellyfin" style={CHIP_PAD}>
          <MonitorPlay style={{ width: 9, height: 9 }} />
          Jellyfin
        </span>
      )}
      {queuedBefore4k ? queued : fourK}
      {queuedBefore4k ? fourK : queued}
      {!media.arr4kAvailable && media.arr4kPending && (
        <span className="ds-chip ds-chip-pending" style={CHIP_PAD}>
          <Clock style={{ width: 9, height: 9 }} />
          {t("media.badge.queued4k")}
        </span>
      )}
      {showRequested && !isAvailable && media.requested && (
        <span className="ds-chip ds-chip-accent" style={CHIP_PAD}>
          <CheckCircle style={{ width: 9, height: 9 }} />
          {t("media.badge.requested")}
        </span>
      )}
    </>
  );
}
