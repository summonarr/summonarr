"use client";

import { useCallback, useEffect, useState } from "react";
import { KpiStrip } from "./kpi-strip";
import { SPEC_STATUS_ANSWER, type SpecStatus, type TrashService } from "./types";
import { specMatches } from "./spec-filters";
import { withBasePath } from "@/lib/base-path";
import { fetchJson } from "@/lib/client/fetch-json";
import { useT } from "@/components/i18n/i18n-provider";

interface OverviewKpisProps {
  service: TrashService;
  // Bumping this triggers a refetch (used by StarterPackCard.onChanged).
  refreshKey?: number;
}

/** The strip's counts. "Applied" is the spec tabs' "managed" (spec-filters.ts): applied and not paused. */
function overviewCounts(specs: readonly SpecStatus[]) {
  let profilesAvailable = 0, profilesApplied = 0, customFormatsTotal = 0, customFormatsApplied = 0, drift = 0;
  for (const s of specs) {
    const managed = specMatches(s, "managed");
    if (s.kind === "QUALITY_PROFILE") {
      profilesAvailable++;
      if (managed) profilesApplied++;
    } else if (s.kind === "CUSTOM_FORMAT") {
      customFormatsTotal++;
      if (managed) customFormatsApplied++;
    }
    if (managed && s.application?.lastError) drift++;
  }
  return { profilesAvailable, profilesApplied, customFormatsTotal, customFormatsApplied, drift };
}

export function OverviewKpis({ service, refreshKey = 0 }: OverviewKpisProps) {
  const t = useT();
  const [specs, setSpecs] = useState<SpecStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async (signal: AbortSignal) => {
    setLoading(true);
    const res = await fetchJson(withBasePath(`/api/admin/trash-guides/status?service=${service.toLowerCase()}`), {
      schema: SPEC_STATUS_ANSWER,
      signal,
    });
    // A superseded request (service switched / refreshKey bumped) must not
    // overwrite the newer one's KPIs or flip loading off early.
    if (signal.aborted) return;
    // A failed or unreadable status shows "—", never zeros (KpiStrip `failed`).
    setSpecs(res.ok ? (res.data.specs ?? []) : []);
    setFailed(!res.ok);
    setLoading(false);
  }, [service]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, refreshKey]);

  const counts = overviewCounts(specs);
  const serviceLabel = service === "SONARR" ? "Sonarr" : "Radarr";

  return (
    <section aria-label={t("trash.kpi.statusAria", { service: serviceLabel })}>
      <p
        className="ds-mono uppercase"
        style={{ fontSize: 10.5, color: "var(--ds-fg-subtle)", letterSpacing: "0.08em", margin: "0 0 8px" }}
      >
        {t("trash.kpi.defaultInstance", { service: serviceLabel })}
      </p>
      <KpiStrip
        profilesAvailable={counts.profilesAvailable}
        profilesApplied={counts.profilesApplied}
        customFormatsApplied={counts.customFormatsApplied}
        customFormatsTotal={counts.customFormatsTotal}
        drift={counts.drift}
        loading={loading}
        failed={failed}
      />
    </section>
  );
}
