// Skeleton for the Votes list while DeletionVote groupBy + batched lookups run.
export default function Loading() {
  return (
    <div className="animate-pulse">
      <div className="flex flex-col gap-2" style={{ marginBottom: 24 }}>
        <div className="rounded" style={{ width: 180, height: 24, background: "var(--ds-bg-3)" }} />
        <div className="rounded" style={{ width: 420, height: 14, background: "var(--ds-bg-2)" }} />
      </div>
      <div className="flex flex-col gap-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex items-start gap-3 rounded-lg" style={{ padding: 14, background: "var(--ds-bg-2)" }}>
            <div className="shrink-0 rounded" style={{ width: 56, height: 84, background: "var(--ds-bg-3)" }} />
            <div className="flex-1 flex flex-col gap-2">
              <div className="rounded" style={{ width: "60%", height: 14, background: "var(--ds-bg-3)" }} />
              <div className="rounded" style={{ width: "30%", height: 12, background: "var(--ds-bg-3)" }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
