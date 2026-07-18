// Root (app) loading boundary — primarily for the home/discover page, the
// heaviest route (7 TMDB rail fetches + availability enrichment) and previously
// the only major one with NO loading state: on a cold TMDB cache, navigating to
// "/" blocked with zero feedback. Shaped like Discover: header + hero pair +
// three horizontal poster rails, using the house animate-pulse + var(--ds-bg-*)
// skeleton conventions (see components/loading/poster-grid-skeleton.tsx).
//
// NOTE: this also covers every child segment without its own loading.tsx —
// currently the fast DB-backed pages (donate, hidden, notifications, profile,
// watchlist), which now get a brief skeleton flash on cold navigations. Every
// heavy segment (movies, tv, detail pages, browse lists, requests, issues,
// votes, settings, the admin subtree) has its own boundary and is unaffected.
export default function Loading() {
  return (
    <div className="animate-pulse">
      {/* Page header */}
      <div className="flex flex-col gap-2" style={{ marginBottom: 24 }}>
        <div className="rounded" style={{ width: 200, height: 24, background: "var(--ds-bg-3)" }} />
        <div className="rounded" style={{ width: 320, height: 14, background: "var(--ds-bg-2)" }} />
      </div>

      {/* Trending hero pair */}
      <div className="grid gap-3 md:grid-cols-2" style={{ marginBottom: 32 }}>
        {Array.from({ length: 2 }).map((_, i) => (
          <div
            key={i}
            className="rounded-lg"
            style={{ height: 220, background: "var(--ds-bg-1)", border: "1px solid var(--ds-border)" }}
          />
        ))}
      </div>

      {/* Poster rails */}
      {Array.from({ length: 3 }).map((_, rail) => (
        <div key={rail} style={{ marginBottom: 28 }}>
          <div className="rounded" style={{ width: 160, height: 18, background: "var(--ds-bg-3)", marginBottom: 12 }} />
          <div className="flex gap-3 overflow-hidden">
            {Array.from({ length: 8 }).map((_, i) => (
              <div
                key={i}
                className="rounded shrink-0"
                style={{ width: 140, aspectRatio: "2 / 3", background: "var(--ds-bg-2)" }}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
