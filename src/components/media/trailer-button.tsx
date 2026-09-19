"use client";

import { Play } from "@/components/icons";
import { safeExternalHref } from "@/lib/safe-url";
import { DETAIL_ACTION_CLASS, detailActionStyle } from "./detail-action-button";

interface TrailerButtonProps {
  trailerKey?: string | null;
  trailerUrl?: string | null;
}

// "Watch Trailer" link — prefers a YouTube key, else falls back to a
// sanitized external URL; renders nothing when neither is present.
export function TrailerButton({ trailerKey, trailerUrl }: TrailerButtonProps) {
  const href = trailerKey
    ? `https://www.youtube.com/watch?v=${trailerKey}`
    : safeExternalHref(trailerUrl);
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={DETAIL_ACTION_CLASS}
      style={detailActionStyle("secondary")}
    >
      <Play style={{ width: 14, height: 14 }} />
      Watch Trailer
    </a>
  );
}
