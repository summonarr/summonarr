"use client";

import { useEffect } from "react";
import { AlertTriangle, Home, RefreshCw } from "@/components/icons";
import {
  StatePage,
  STATE_PAGE_CTA_CLASS,
  statePageCtaStyle,
} from "@/components/layout/state-page";
import { useT } from "@/components/i18n/i18n-provider";

// Section-scoped error boundary for the admin subtree. Without it, a render
// error in any admin page bubbles to the (app)-root boundary and unmounts the
// whole authenticated shell; scoping it here keeps a failing admin panel from
// taking down navigation. Mirrors src/app/(app)/error.tsx (Next 16 passes
// `retry`, not `reset`).
export default function AdminError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  const t = useT();
  useEffect(() => {
    console.error("[admin/error]", error);
  }, [error]);

  return (
    <StatePage
      glyph={<AlertTriangle style={{ width: 56, height: 56 }} />}
      title={t("shared.error.adminTitle")}
      description={t("shared.error.adminDescription")}
      primary={
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
