"use client";

import { useEffect } from "react";
import { Home, RefreshCw } from "@/components/icons";
import {
  StatePage,
  STATE_PAGE_CTA_CLASS,
  statePageCtaStyle,
} from "@/components/layout/state-page";
import { useT } from "@/components/i18n/i18n-provider";

export default function AppError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  const t = useT();
  useEffect(() => {
    console.error("[app/error]", error);
  }, [error]);

  return (
    <StatePage
      glyph="500"
      title={t("shared.error.title")}
      description={t("shared.error.description")}
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
          {t("shared.error.tryAgain")}
        </button>
      }
      secondary={[{ label: t("shared.error.goHome"), href: "/", icon: <Home className="w-4 h-4" /> }]}
    />
  );
}
