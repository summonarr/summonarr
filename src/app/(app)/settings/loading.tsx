// Skeleton for the admin Settings page — header + tab bar + card placeholders.
// The page aggregates many Setting reads plus live Plex/Jellyfin status probes
// before render, so a fallback keeps the navigation feeling immediate.
export default function Loading() {
  return (
    <div className="animate-pulse">
      {/* Page header */}
      <div className="flex flex-col gap-2" style={{ marginBottom: 24 }}>
        <div className="rounded" style={{ width: 180, height: 24, background: "var(--ds-bg-3)" }} />
        <div className="rounded" style={{ width: 300, height: 14, background: "var(--ds-bg-2)" }} />
      </div>

      {/* Tab bar */}
      <div className="flex gap-2 overflow-hidden" style={{ marginBottom: 24 }}>
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="rounded shrink-0"
            style={{ width: 96, height: 30, background: "var(--ds-bg-2)" }}
          />
        ))}
      </div>

      {/* Settings cards */}
      <div className="flex flex-col gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="rounded-lg"
            style={{ height: 140, background: "var(--ds-bg-1)", border: "1px solid var(--ds-border)" }}
          />
        ))}
      </div>
    </div>
  );
}
