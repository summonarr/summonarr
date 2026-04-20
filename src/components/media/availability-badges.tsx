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
  const isAvailable = !!((showPlex && plexAvailable) || (showJellyfin && jellyfinAvailable));
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
        <span className="inline-flex items-center gap-1 bg-[#e5a00d]/90 rounded-full px-2 py-0.5 text-[10px] text-black font-semibold">
          <PlayCircle className="w-3 h-3" />
          On Plex
        </span>
      )}
      {showJellyfinBadge && (
        <span className="inline-flex items-center gap-1 bg-[#00a4dc]/90 rounded-full px-2 py-0.5 text-[10px] text-white font-semibold">
          <MonitorPlay className="w-3 h-3" />
          On Jellyfin
        </span>
      )}
      {showQueueBadge && (
        <span className="inline-flex items-center gap-1 bg-orange-500/90 rounded-full px-2 py-0.5 text-[10px] text-white font-semibold">
          <Clock className="w-3 h-3" />
          Approved in Queue
        </span>
      )}
      {showRequestedBadge && (
        <span className="inline-flex items-center gap-1 bg-indigo-600/90 rounded-full px-2 py-0.5 text-[10px] text-white font-semibold">
          <CheckCircle className="w-3 h-3" />
          Requested
        </span>
      )}
    </div>
  );
}
