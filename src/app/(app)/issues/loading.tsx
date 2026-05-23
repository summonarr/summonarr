// Skeleton for the Issues list while Prisma loads thread metadata + counts.
export default function Loading() {
  return (
    <div className="animate-pulse">
      <div className="flex flex-col gap-2" style={{ marginBottom: 24 }}>
        <div className="rounded" style={{ width: 160, height: 24, background: "var(--ds-bg-3)" }} />
        <div className="rounded" style={{ width: 320, height: 14, background: "var(--ds-bg-2)" }} />
      </div>
      <div className="flex flex-col gap-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="rounded-lg" style={{ height: 72, background: "var(--ds-bg-2)" }} />
        ))}
      </div>
    </div>
  );
}
