"use client";

import { useEffect } from "react";
import { AlertTriangle, Home, RefreshCw } from "@/components/icons";
import {
  StatePage,
  STATE_PAGE_CTA_CLASS,
  statePageCtaStyle,
} from "@/components/layout/state-page";

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
  useEffect(() => {
    console.error("[admin/error]", error);
  }, [error]);

  return (
    <StatePage
      glyph={<AlertTriangle style={{ width: 56, height: 56 }} />}
      title="Admin panel error"
      description="Something went wrong loading this admin section. The rest of the app is unaffected."
      primary={
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
