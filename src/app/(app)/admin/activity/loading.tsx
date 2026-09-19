// Loading skeleton for the admin Activity section — every route under it is
// force-dynamic with several play-history aggregation queries before render,
// so a fallback keeps navigation feeling immediate. It mirrors the shared
// composition every Activity page renders: PageHeader → tab strip (+ the
// period/source/type segments) → content blocks.
export default function Loading() {
  return (
    <div className="animate-pulse">
      {/* Page header: 22px title + 12px mono subtitle (PageHeader, mb-5) */}
      <div className="flex flex-col gap-2" style={{ marginBottom: 20 }}>
        <div
          className="rounded"
          style={{ width: 180, height: 24, background: "var(--ds-bg-3)" }}
        />
        <div
          className="rounded"
          style={{ width: 320, height: 14, background: "var(--ds-bg-2)" }}
        />
      </div>

      {/* Tab strip — below the header on every Activity route */}
      <div
        className="flex items-center gap-1 pb-3 overflow-hidden"
        style={{ marginBottom: 12, borderBottom: "1px solid var(--ds-border)" }}
      >
        {[80, 66, 56, 52, 116].map((w, i) => (
          <div
            key={i}
            className="rounded-md shrink-0"
            style={{
              width: w,
              height: 32,
              background: i === 0 ? "var(--ds-bg-3)" : "var(--ds-bg-2)",
            }}
          />
        ))}
      </div>

      {/* Period / source / type segments */}
      <div className="flex flex-wrap items-center gap-4" style={{ marginBottom: 24 }}>
        {[210, 150, 150].map((w, i) => (
          <div
            key={i}
            className="rounded-lg"
            style={{ width: w, height: 34, background: "var(--ds-bg-2)" }}
          />
        ))}
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
