// Generic shimmer skeleton for admin pages (tables, dashboards, stats). Neutral
// enough to sit under the whole admin subtree via a single loading.tsx, so slow
// admin routes (library diff, audit log, stats, users, backup) show feedback
// instead of blocking on the server render.
export function AdminSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div className="animate-pulse">
      <div className="flex flex-col gap-2" style={{ marginBottom: 24 }}>
        <div className="rounded" style={{ width: 220, height: 22, background: "var(--ds-bg-3)" }} />
        <div className="rounded" style={{ width: 340, height: 13, background: "var(--ds-bg-2)" }} />
      </div>
      <div className="flex flex-col gap-2">
        {Array.from({ length: rows }).map((_, i) => (
          <div
            key={i}
            className="rounded"
            style={{ height: 44, background: "var(--ds-bg-1)", border: "1px solid var(--ds-border)" }}
          />
        ))}
      </div>
    </div>
  );
}
