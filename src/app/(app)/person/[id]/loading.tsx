// Skeleton for the person page (TMDB person + combined credits). Mirrors
// PersonView: the 120×180 photo (radius 8) beside the 32px name, the
// born/known-for line and a three-line bio, then the credits section — title
// row with the movie/tv filter pills (32px) and a .ds-media-grid of
// MediaCard tiles. No horizontal padding: PersonView sits directly in
// <main>'s inset like every other page.
import { Bar, MediaCardTile, SKELETON_FILL } from "@/components/loading/poster-grid-skeleton";

export default function Loading() {
  return (
    <div className="animate-pulse">
      <div className="flex flex-wrap" style={{ gap: 20, paddingBottom: 24 }}>
        <div className="shrink-0" style={{ width: 120, height: 180, borderRadius: 8, background: SKELETON_FILL }} />
        <div className="flex flex-col" style={{ flex: 1, minWidth: 260, gap: 10 }}>
          <Bar w={280} h={34} style={{ maxWidth: "100%" }} />
          <Bar w={180} h={12} />
          <div className="flex flex-col" style={{ gap: 8, maxWidth: 720 }}>
            <Bar w="100%" h={13} />
            <Bar w="94%" h={13} />
            <Bar w="70%" h={13} />
          </div>
        </div>
      </div>
      <section style={{ paddingBottom: 32 }}>
        <div className="flex flex-wrap items-center" style={{ gap: 12, marginBottom: 12 }}>
          <Bar w={100} h={18} />
          <div className="inline-flex" style={{ gap: 6 }}>
            {Array.from({ length: 3 }).map((_, i) => (
              <Bar key={i} w={64} h={32} r={999} />
            ))}
          </div>
        </div>
        <div className="ds-media-grid">
          {Array.from({ length: 12 }).map((_, i) => (
            <MediaCardTile key={i} />
          ))}
        </div>
      </section>
    </div>
  );
}
