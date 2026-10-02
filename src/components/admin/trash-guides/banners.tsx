"use client";

import { useState } from "react";
import { useHasMounted } from "@/hooks/use-has-mounted";
import { Card } from "@/components/ui/card";
import { AlertTriangle, XCircle } from "@/components/icons";
import { useLocale, useT } from "@/components/i18n/i18n-provider";

export function RefreshErrorBanner({
  error,
  onDismiss,
}: {
  error: { errors: string[]; schemaDiagnostic?: string };
  onDismiss: () => void;
}) {
  const t = useT();
  return (
    <Card className="bg-red-500/10 border-red-500/40 p-4 text-sm">
      <div className="flex items-start gap-3">
        <XCircle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="font-medium text-red-400">{t("trash.banner.refreshFailed")}</p>
          {error.schemaDiagnostic && (
            <div className="mt-2 p-2.5 bg-amber-500/10 border border-amber-500/30 rounded text-amber-400 text-xs">
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                <div>
                  <p className="font-medium">{t("trash.banner.schemaOutOfSync")}</p>
                  <p className="mt-0.5">{error.schemaDiagnostic}</p>
                </div>
              </div>
            </div>
          )}
          {error.errors.length > 0 && (
            <ul className="mt-2 space-y-1 text-xs text-red-400 font-mono">
              {error.errors.map((e, i) => (
                <li key={i} className="break-all">{e}</li>
              ))}
            </ul>
          )}
        </div>
        <button onClick={onDismiss} className="text-xs text-red-400 hover:text-[var(--ds-danger-hover)]">{t("trash.common.dismiss")}</button>
      </div>
    </Card>
  );
}

// `at` timestamp is rendered as plain text (no relative-time math) — staleness is gated server-side
// in the layout, so the banner only appears when the truncation is recent enough to act on.
export function TruncationBanner({ at }: { at: string }) {
  const mounted = useHasMounted();
  const t = useT();
  const locale = useLocale();
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  return (
    <Card className="bg-amber-500/10 border-amber-500/40 p-4 text-sm">
      <div className="flex items-start gap-3">
        <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="font-medium text-amber-400">{t("trash.banner.truncatedTitle")}</p>
          <p className="mt-1 text-zinc-100">
            {t("trash.banner.truncatedBody", {
              at: mounted ? new Date(at).toLocaleString(locale, { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" }) + " UTC" : "",
            })}
          </p>
          <p className="mt-2 text-xs text-zinc-400">
            {t("trash.banner.truncatedHint")}
          </p>
        </div>
        <button onClick={() => setDismissed(true)} className="text-xs text-amber-400 hover:text-zinc-100">{t("trash.common.dismiss")}</button>
      </div>
    </Card>
  );
}
