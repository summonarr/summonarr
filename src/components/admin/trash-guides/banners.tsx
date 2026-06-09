"use client";

import { useState } from "react";
import { Card } from "@/components/ui/card";
import { AlertTriangle, XCircle } from "@/components/icons";

export function RefreshErrorBanner({
  error,
  onDismiss,
}: {
  error: { errors: string[]; schemaDiagnostic?: string };
  onDismiss: () => void;
}) {
  return (
    <Card className="bg-red-500/10 border-red-500/40 p-4 text-sm">
      <div className="flex items-start gap-3">
        <XCircle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="font-medium text-red-200">Refresh Catalog failed</p>
          {error.schemaDiagnostic && (
            <div className="mt-2 p-2.5 bg-amber-500/10 border border-amber-500/30 rounded text-amber-200 text-xs">
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                <div>
                  <p className="font-medium">Schema out of sync</p>
                  <p className="mt-0.5">{error.schemaDiagnostic}</p>
                </div>
              </div>
            </div>
          )}
          {error.errors.length > 0 && (
            <ul className="mt-2 space-y-1 text-xs text-red-300 font-mono">
              {error.errors.map((e, i) => (
                <li key={i} className="break-all">{e}</li>
              ))}
            </ul>
          )}
        </div>
        <button onClick={onDismiss} className="text-xs text-red-400 hover:text-red-200">dismiss</button>
      </div>
    </Card>
  );
}

// `at` timestamp is rendered as plain text (no relative-time math) — staleness is gated server-side
// in the layout, so the banner only appears when the truncation is recent enough to act on.
export function TruncationBanner({ at }: { at: string }) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  return (
    <Card className="bg-amber-500/10 border-amber-500/40 p-4 text-sm">
      <div className="flex items-start gap-3">
        <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="font-medium text-amber-200">GitHub tree response was truncated</p>
          <p className="mt-1 text-amber-100/90">
            The TRaSH-Guides repo exceeded GitHub&apos;s recursive-tree response cap on the last refresh
            ({new Date(at).toUTCString()}). Some specs may have been silently skipped.
          </p>
          <p className="mt-2 text-xs text-amber-300/80">
            Configure a GitHub personal access token on the Settings tab to lift rate limits, then click
            <span className="font-semibold"> Refresh Catalog</span>. If the issue persists, the upstream
            repo has outgrown the API page size — file an issue.
          </p>
        </div>
        <button onClick={() => setDismissed(true)} className="text-xs text-amber-400 hover:text-amber-200">dismiss</button>
      </div>
    </Card>
  );
}
