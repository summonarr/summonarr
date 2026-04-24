"use client";

import { Play } from "lucide-react";

interface TrailerButtonProps {
  trailerKey?: string | null;
  trailerUrl?: string | null;
}

export function TrailerButton({ trailerKey, trailerUrl }: TrailerButtonProps) {
  const href = trailerKey
    ? `https://www.youtube.com/watch?v=${trailerKey}`
    : trailerUrl;
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="ds-tap inline-flex items-center gap-2 font-medium transition-colors"
      style={{
        padding: "6px 12px",
        height: 32,
        borderRadius: 6,
        background: "var(--ds-bg-2)",
        color: "var(--ds-fg)",
        border: "1px solid var(--ds-border)",
        fontSize: 13,
      }}
    >
      <Play style={{ width: 14, height: 14 }} />
      Watch Trailer
    </a>
  );
}
