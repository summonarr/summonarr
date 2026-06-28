// Loading skeleton for the movie detail page — the route fetches TMDB details +
// credits + suggestions + several Prisma lookups before render, so a fallback
// keeps navigation feeling immediate.
export default function Loading() {
  return (
    <div className="animate-pulse">
      {/* Backdrop */}
      <div
        className="w-full"
        style={{ height: 320, background: "var(--ds-bg-2)" }}
      />

      <div style={{ padding: "0 16px" }}>
        <div className="flex gap-6" style={{ marginTop: -80 }}>
          {/* Poster */}
          <div
            className="shrink-0 rounded-lg"
            style={{ width: 200, height: 300, background: "var(--ds-bg-3)" }}
          />

          {/* Title + meta */}
          <div className="flex-1 flex flex-col gap-3" style={{ paddingTop: 96 }}>
            <div
              className="rounded"
              style={{ width: "55%", height: 28, background: "var(--ds-bg-3)" }}
            />
            <div
              className="rounded"
              style={{ width: "35%", height: 16, background: "var(--ds-bg-2)" }}
            />
            <div className="flex gap-2">
              <div
                className="rounded-md"
                style={{ width: 130, height: 34, background: "var(--ds-bg-2)" }}
              />
              <div
                className="rounded-md"
                style={{ width: 130, height: 34, background: "var(--ds-bg-2)" }}
              />
            </div>
            <div className="flex flex-col gap-2" style={{ marginTop: 8 }}>
              <div
                className="rounded"
                style={{ width: "90%", height: 14, background: "var(--ds-bg-2)" }}
              />
              <div
                className="rounded"
                style={{ width: "80%", height: 14, background: "var(--ds-bg-2)" }}
              />
              <div
                className="rounded"
                style={{ width: "60%", height: 14, background: "var(--ds-bg-2)" }}
              />
            </div>
          </div>
        </div>

        {/* Cast row */}
        <div className="grid grid-cols-3 sm:grid-cols-6 lg:grid-cols-8 gap-3" style={{ marginTop: 40 }}>
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex flex-col items-center gap-2">
              <div
                className="rounded-full"
                style={{ width: 56, height: 56, background: "var(--ds-bg-3)" }}
              />
              <div
                className="rounded"
                style={{ width: 48, height: 10, background: "var(--ds-bg-2)" }}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
