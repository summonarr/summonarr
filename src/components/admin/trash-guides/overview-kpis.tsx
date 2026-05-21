"use client";

import { useCallback, useEffect, useState } from "react";
import { KpiStrip } from "./kpi-strip";
import type { SpecStatus, TrashService } from "./types";

interface OverviewKpisProps {
  service: TrashService;
  // Bumping this triggers a refetch (used by StarterPackCard.onChanged).
  refreshKey?: number;
}

export function OverviewKpis({ service, refreshKey = 0 }: OverviewKpisProps) {
  const [specs, setSpecs] = useState<SpecStatus[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/trash-guides/status?service=${service.toLowerCase()}`);
      const data = (await res.json()) as { specs?: SpecStatus[] };
      setSpecs(data.specs ?? []);
    } catch {
      setSpecs([]);
    }
    setLoading(false);
  }, [service]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const profilesAvailable = specs.filter((s) => s.kind === "QUALITY_PROFILE").length;
  const profilesApplied   = specs.filter((s) => s.kind === "QUALITY_PROFILE" && s.application?.enabled).length;
  const customFormatsTotal   = specs.filter((s) => s.kind === "CUSTOM_FORMAT").length;
  const customFormatsApplied = specs.filter((s) => s.kind === "CUSTOM_FORMAT" && s.application?.enabled).length;
  const driftCount = specs.filter((s) => s.application?.enabled && s.application.lastError).length;

  return (
    <KpiStrip
      profilesAvailable={profilesAvailable}
      profilesApplied={profilesApplied}
      customFormatsApplied={customFormatsApplied}
      customFormatsTotal={customFormatsTotal}
      drift={driftCount}
      loading={loading}
    />
  );
}
