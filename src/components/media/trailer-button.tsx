"use client";

import { ExternalLink, Play } from "@/components/icons";
import { safeExternalHref } from "@/lib/safe-url";
import { useT } from "@/components/i18n/i18n-provider";
import { DETAIL_ACTION_CLASS, detailActionStyle } from "./detail-action-button";

interface TrailerButtonProps {
  trailerKey?: string | null;
  trailerUrl?: string | null;
}

// "Watch Trailer" link — prefers a YouTube key, else falls back to a
// sanitized external URL; renders nothing when neither is present.
export function TrailerButton({ trailerKey, trailerUrl }: TrailerButtonProps) {
  const t = useT();
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
      {t("detail.watchTrailer")}
      {/* Opens YouTube in a new tab — the one detail action that leaves the app. */}
      <ExternalLink style={{ width: 12, height: 12, opacity: 0.6 }} />
    </a>
  );
}
