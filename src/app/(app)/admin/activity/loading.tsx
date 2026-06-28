// Loading skeleton for the admin Activity page — force-dynamic with several
// play-history aggregation queries before render, so a fallback keeps
// navigation feeling immediate.
export default function Loading() {
  return (
    <div className="animate-pulse">
      {/* Page header */}
      <div className="flex flex-col gap-2" style={{ marginBottom: 24 }}>
        <div
          className="rounded"
          style={{ width: 180, height: 24, background: "var(--ds-bg-3)" }}
        />
        <div
          className="rounded"
          style={{ width: 320, height: 14, background: "var(--ds-bg-2)" }}
        />
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3" style={{ marginBottom: 24 }}>
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="rounded-lg"
            style={{ height: 84, background: "var(--ds-bg-2)" }}
          />
        ))}
      </div>

      {/* Analytics row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4" style={{ marginBottom: 24 }}>
        <div
          className="rounded-lg"
          style={{ height: 220, background: "var(--ds-bg-2)" }}
        />
        <div
          className="rounded-lg"
          style={{ height: 220, background: "var(--ds-bg-2)" }}
        />
      </div>

      {/* Calendar heatmap */}
      <div
        className="rounded-lg"
        style={{ height: 160, background: "var(--ds-bg-2)" }}
      />

      {/* Recent plays list */}
      <div className="flex flex-col gap-2" style={{ marginTop: 24 }}>
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="rounded-lg"
            style={{ height: 48, background: "var(--ds-bg-2)" }}
          />
        ))}
      </div>
    </div>
  );
}
