"use client";

import { useCallback } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { FilterBar } from "@/components/ui/design";
import { useT } from "@/components/i18n/i18n-provider";
import { DEFAULT_STATS_RANGE, STATS_RANGES, type StatsRange } from "@/lib/admin-stats";

// Period filter for /admin/stats, kept in the URL (`?range=`) so a view can be
// linked and Back/Forward works. The default is written as no param at all.
export function StatsRangeFilter({ active }: { active: StatsRange }) {
  const t = useT();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const labels: Record<StatsRange, string> = {
    "30": t("adminManage.stats.range.30"),
    "90": t("adminManage.stats.range.90"),
    "365": t("adminManage.stats.range.365"),
    all: t("adminManage.stats.range.all"),
  };

  const onChange = useCallback(
    (value: StatsRange) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value === DEFAULT_STATS_RANGE) params.delete("range");
      else params.set("range", value);
      const qs = params.toString();
      // The page is force-dynamic, so the push alone re-renders it.
      router.push(qs ? `${pathname}?${qs}` : pathname);
    },
    [router, pathname, searchParams],
  );

  return (
    <FilterBar
      segments={STATS_RANGES.map((r) => ({ value: r, label: labels[r] }))}
      active={active}
      onChange={onChange}
    />
  );
}
