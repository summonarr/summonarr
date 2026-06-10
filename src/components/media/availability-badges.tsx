import { PlayCircle, MonitorPlay, Clock, CheckCircle } from "@/components/icons";
import { cn } from "@/lib/utils";

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

export function AvailabilityBadges({
  plexAvailable,
  jellyfinAvailable,
  arrPending,
  requested,
  arr4kAvailable,
  arr4kPending,
  showPlex,
  showJellyfin,
  show4k,
  className,
}: AvailabilityBadgesProps) {
  // All state is derived from cache tables; badges are only as fresh as the last library sync
  const isAvailable = !!(
    (showPlex && plexAvailable) ||
    (showJellyfin && jellyfinAvailable)
  );
  const showPlexBadge = showPlex && plexAvailable;
  const showJellyfinBadge = showJellyfin && jellyfinAvailable;
  const showQueueBadge = !isAvailable && !!arrPending;
  const showRequestedBadge = !isAvailable && !arrPending && !!requested;
  // 4K is an independent dimension from library/HD state — a title can be downloading in HD while
  // already present in 4K, so these render alongside (not instead of) the badges above.
  const show4kAvailBadge = !!(show4k && arr4kAvailable);
  const show4kQueueBadge = !!(show4k && !arr4kAvailable && arr4kPending);

  if (
    !showPlexBadge && !showJellyfinBadge && !showQueueBadge &&
    !showRequestedBadge && !show4kAvailBadge && !show4kQueueBadge
  ) {
    return null;
  }

  return (
    <div className={cn("flex flex-wrap items-center gap-1", className)}>
      {showPlexBadge && (
        <span className="ds-chip ds-chip-plex">
          <PlayCircle style={{ width: 10, height: 10 }} />
          On Plex
        </span>
      )}
      {showJellyfinBadge && (
        <span className="ds-chip ds-chip-jellyfin">
          <MonitorPlay style={{ width: 10, height: 10 }} />
          On Jellyfin
        </span>
      )}
      {show4kAvailBadge && (
        <span
          className="ds-chip"
          style={{
            background: "var(--ds-accent-soft)",
            color: "var(--ds-accent)",
            border: "1px solid var(--ds-accent-ring)",
          }}
        >
          <CheckCircle style={{ width: 10, height: 10 }} />
          Available in 4K
        </span>
      )}
      {showQueueBadge && (
        <span className="ds-chip ds-chip-pending">
          <Clock style={{ width: 10, height: 10 }} />
          Approved in Queue
        </span>
      )}
      {show4kQueueBadge && (
        <span className="ds-chip ds-chip-pending">
          <Clock style={{ width: 10, height: 10 }} />
          4K in Queue
        </span>
      )}
      {showRequestedBadge && (
        <span className="ds-chip ds-chip-accent">
          <CheckCircle style={{ width: 10, height: 10 }} />
          Requested
        </span>
      )}
    </div>
  );
}
