// Skeleton for the Requests list while server-side Prisma queries warm up.
export default function Loading() {
  return (
    <div className="animate-pulse">
      <div className="flex flex-col gap-2" style={{ marginBottom: 24 }}>
        <div className="rounded" style={{ width: 200, height: 24, background: "var(--ds-bg-3)" }} />
        <div className="rounded" style={{ width: 360, height: 14, background: "var(--ds-bg-2)" }} />
      </div>
      <div className="flex flex-col gap-2">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="rounded-lg" style={{ height: 84, background: "var(--ds-bg-2)" }} />
        ))}
      </div>
    </div>
  );
}
