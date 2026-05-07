"use client";

export function KpiStrip({
  profilesAvailable,
  profilesApplied,
  customFormatsApplied,
  customFormatsTotal,
  drift,
  loading,
}: {
  profilesAvailable: number;
  profilesApplied: number;
  customFormatsApplied: number;
  customFormatsTotal: number;
  drift: number;
  loading: boolean;
}) {
  const kpis = [
    {
      label: "Profiles available",
      value: loading ? "…" : String(profilesAvailable),
      hint: "from TRaSH-Guides",
      tint: "var(--ds-fg)",
    },
    {
      label: "Applied to instance",
      value: loading ? "…" : String(profilesApplied),
      hint: `of ${profilesAvailable}`,
      tint: profilesApplied > 0 ? "var(--ds-accent)" : "var(--ds-fg)",
    },
    {
      label: "Custom formats",
      value: loading ? "…" : String(customFormatsTotal),
      hint: `${customFormatsApplied} applied`,
      tint: "var(--ds-fg)",
    },
    {
      label: "Drift",
      value: loading ? "…" : drift === 0 ? "0 diffs" : `${drift} diff${drift !== 1 ? "s" : ""}`,
      hint: drift === 0 ? "In sync with upstream" : "Review errors",
      tint: drift === 0 ? "var(--ds-success)" : "var(--ds-warning)",
    },
  ];

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
