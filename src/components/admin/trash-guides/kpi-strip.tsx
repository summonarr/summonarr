"use client";

import { useT } from "@/components/i18n/i18n-provider";

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
  if (failed && !loading) {
    const kpis = [
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
    return <KpiGrid kpis={kpis} />;
  }
  const kpis = [
    {
      label: t("trash.kpi.profilesAvailable"),
      value: loading ? "…" : String(profilesAvailable),
      hint: t("trash.kpi.fromTrash"),
      tint: "var(--ds-fg)",
    },
    {
      label: t("trash.kpi.appliedToInstance"),
      value: loading ? "…" : String(profilesApplied),
      hint: t("trash.kpi.ofTotal", { total: profilesAvailable }),
      tint: profilesApplied > 0 ? "var(--ds-accent-text)" : "var(--ds-fg)",
    },
    {
      label: t("trash.kpi.customFormats"),
      value: loading ? "…" : String(customFormatsTotal),
      hint: t("trash.kpi.appliedCount", { count: customFormatsApplied }),
      tint: "var(--ds-fg)",
    },
    {
      label: t("trash.kpi.drift"),
      value: loading ? "…" : t("trash.kpi.diffs", { count: drift }),
      hint: drift === 0 ? t("trash.kpi.inSync") : t("trash.kpi.reviewErrors"),
      tint: drift === 0 ? "var(--ds-success)" : "var(--ds-warning)",
    },
  ];

  return <KpiGrid kpis={kpis} />;
}

function KpiGrid({ kpis }: { kpis: { label: string; value: string; hint: string; tint: string }[] }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4" style={{ gap: 10 }}>
      {kpis.map((k) => (
        <div
          key={k.label}
          style={{
            padding: "14px 16px",
            background: "var(--ds-bg-2)",
            border: "1px solid var(--ds-border)",
            borderRadius: 8,
          }}
        >
          <p
            className="ds-mono uppercase"
            style={{
              fontSize: 10.5,
              color: "var(--ds-fg-subtle)",
              letterSpacing: "0.08em",
              margin: "0 0 6px",
            }}
          >
            {k.label}
          </p>
          <p
            className="font-semibold"
            style={{ fontSize: 22, color: k.tint, margin: 0, letterSpacing: "-0.02em" }}
          >
            {k.value}
          </p>
          {k.hint && (
            <p
              className="ds-mono"
              style={{ margin: "4px 0 0", fontSize: 10, color: "var(--ds-fg-subtle)" }}
            >
              {k.hint}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}
