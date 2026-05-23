// Shared skeleton for TMDB-backed poster grids (upcoming / popular / top).
// Mirrors the page-header + responsive poster-grid layout so the route swap
// feels instant.
export function PosterGridSkeleton({
  title,
  subtitle,
  rows = 4,
}: {
  title?: string;
  subtitle?: string;
  rows?: number;
}) {
  return (
    <div className="animate-pulse">
      <div className="flex flex-col gap-2" style={{ marginBottom: 24 }}>
        {title ? (
          <div className="rounded" style={{ width: 200, height: 24, background: "var(--ds-bg-3)" }} />
        ) : null}
        {subtitle ? (
          <div className="rounded" style={{ width: 380, height: 14, background: "var(--ds-bg-2)" }} />
        ) : null}
      </div>
      <div
        className="grid gap-3"
        style={{
          gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
        }}
      >
        {Array.from({ length: rows * 6 }).map((_, i) => (
          <div
            key={i}
            className="rounded"
            style={{ aspectRatio: "2 / 3", background: "var(--ds-bg-2)" }}
          />
        ))}
      </div>
    </div>
  );
}
