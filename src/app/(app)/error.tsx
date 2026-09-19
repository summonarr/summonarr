"use client";

import { useEffect } from "react";
import { Home, RefreshCw } from "@/components/icons";
import {
  StatePage,
  STATE_PAGE_CTA_CLASS,
  statePageCtaStyle,
} from "@/components/layout/state-page";

export default function AppError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error("[app/error]", error);
  }, [error]);

  return (
    <StatePage
      glyph="500"
      title="Something went wrong"
      description="An unexpected error occurred. Trying again re-renders this page; if it keeps failing, head home."
      primary={
        // The retry callback is client-only, so the shell takes this ready-made
        // button in its primary slot rather than a link config.
        <button
          type="button"
          onClick={() => retry()}
          className={STATE_PAGE_CTA_CLASS}
          style={statePageCtaStyle("primary")}
        >
          <RefreshCw className="w-4 h-4" />
          Try again
        </button>
      }
      secondary={[{ label: "Go home", href: "/", icon: <Home className="w-4 h-4" /> }]}
    />
  );
}
