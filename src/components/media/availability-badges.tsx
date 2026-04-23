import { PlayCircle, MonitorPlay, Clock, CheckCircle } from "lucide-react";
import { cn } from "@/lib/utils";

export interface AvailabilityBadgesProps {
  plexAvailable?: boolean;
  jellyfinAvailable?: boolean;
  arrPending?: boolean;
  requested?: boolean;
  showPlex: boolean;
  showJellyfin: boolean;
  className?: string;
}

export function AvailabilityBadges({
  plexAvailable,
  jellyfinAvailable,
  arrPending,
  requested,
  showPlex,
  showJellyfin,
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

  if (!showPlexBadge && !showJellyfinBadge && !showQueueBadge && !showRequestedBadge) {
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
      {showQueueBadge && (
        <span className="ds-chip ds-chip-pending">
          <Clock style={{ width: 10, height: 10 }} />
          Approved in Queue
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
