"use client";

import { useState } from "react";
import { OverviewKpis } from "./overview-kpis";
import { StarterPackCard } from "./starter-pack-card";
import type { TrashService } from "./types";

interface OverviewTabProps {
  service: TrashService;
  radarrConfigured: boolean;
  sonarrConfigured: boolean;
}

export function OverviewTab({
  service,
  radarrConfigured,
  sonarrConfigured,
}: OverviewTabProps) {
  const [refreshKey, setRefreshKey] = useState(0);

  return (
    <div className="space-y-6 max-w-6xl">
      <StarterPackCard
        radarrConfigured={radarrConfigured}
        sonarrConfigured={sonarrConfigured}
        onChanged={() => setRefreshKey((n) => n + 1)}
      />
      <OverviewKpis service={service} refreshKey={refreshKey} />
    </div>
  );
}
