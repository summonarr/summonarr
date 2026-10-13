"use client";

// The line an admin Radarr/Sonarr page shows while it paints a snapshot
// (use-arr-snapshot.ts): when the shown data was read, and that a live read is
// on its way — or, once that read has stopped without an answer, that the data
// shown is the last good one.
import { RefreshCw } from "@/components/icons";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import { useHasMounted } from "@/hooks/use-has-mounted";
import { formatRelativeTimeLocalized } from "@/lib/relative-time";

export function ArrSnapshotNote({ at, refreshing }: { at: string | null; refreshing: boolean }) {
  const t = useT();
  const locale = useLocale();
  // The relative time reads the clock: after mount only (guardrail 16).
  const mounted = useHasMounted();
  if (!at || !mounted) return null;
  const when = formatRelativeTimeLocalized(at, locale);
  return (
    <p role="status" className="flex items-center gap-1.5 text-xs text-zinc-400">
      <RefreshCw size={12} className={refreshing ? "shrink-0 animate-spin" : "shrink-0"} aria-hidden="true" />
      {refreshing ? t("adminArr.snapshot.refreshing", { when }) : t("adminArr.snapshot.stale", { when })}
    </p>
  );
}
