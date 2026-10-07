"use client";

import { StatCard } from "@/components/ui/design";
import { useT } from "@/components/i18n/i18n-provider";

interface Kpi {
  label: string;
  value: string;
  hint: string;
  tint: string;
}

export function KpiStrip({
  profilesAvailable,
  profilesApplied,
  customFormatsApplied,
  customFormatsTotal,
  drift,
  loading,
  failed = false,
}: {
  profilesAvailable: number;
  profilesApplied: number;
  customFormatsApplied: number;
  customFormatsTotal: number;
  drift: number;
  loading: boolean;
  // The status fetch failed — show "—" rather than zeros, which would read as
  // an all-clear (a green "0 diffs / In sync with upstream").
  failed?: boolean;
}) {
  const t = useT();
  let kpis: Kpi[];
  if (failed && !loading) {
    kpis = [
      t("trash.kpi.profilesAvailable"),
      t("trash.kpi.appliedToInstance"),
      t("trash.kpi.customFormats"),
      t("trash.kpi.drift"),
    ].map((label) => ({
      label,
      value: "—",
      hint: t("trash.kpi.statusUnavailable"),
      tint: "var(--ds-fg-muted)",
    }));
  } else {
    // While loading the counts are the initial zeros, so a hint or tint derived
    // from them ("In sync with upstream", "of 0", green) would be a false
    // all-clear that flashes before the fetch lands — keep both neutral.
    kpis = [
      {
        label: t("trash.kpi.profilesAvailable"),
        value: loading ? "…" : String(profilesAvailable),
        hint: loading ? "" : t("trash.kpi.fromTrash"),
        tint: "var(--ds-fg)",
      },
      {
        label: t("trash.kpi.appliedToInstance"),
        value: loading ? "…" : String(profilesApplied),
        hint: loading ? "" : t("trash.kpi.ofTotal", { total: profilesAvailable }),
        tint: !loading && profilesApplied > 0 ? "var(--ds-accent-text)" : "var(--ds-fg)",
      },
      {
        label: t("trash.kpi.customFormats"),
        value: loading ? "…" : String(customFormatsTotal),
        hint: loading ? "" : t("trash.kpi.appliedCount", { count: customFormatsApplied }),
        tint: "var(--ds-fg)",
      },
      {
        label: t("trash.kpi.drift"),
        value: loading ? "…" : t("trash.kpi.diffs", { count: drift }),
        hint: loading ? "" : drift === 0 ? t("trash.kpi.inSync") : t("trash.kpi.reviewErrors"),
        tint: loading ? "var(--ds-fg)" : drift === 0 ? "var(--ds-success)" : "var(--ds-warning)",
      },
    ];
  }

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4" style={{ gap: 10 }}>
      {kpis.map((k) => (
        <StatCard
          key={k.label}
          label={k.label}
          value={<span style={{ color: k.tint }}>{k.value}</span>}
          hint={k.hint || undefined}
        />
      ))}
    </div>
  );
}
