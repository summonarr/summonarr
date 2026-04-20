import { MediaCard } from "./media-card";
import type { TmdbMedia } from "@/lib/tmdb-types";

interface SimilarRowProps {
  items: TmdbMedia[];
  showPlex?: boolean;
  showJellyfin?: boolean;
}

export function SimilarRow({ items, showPlex, showJellyfin }: SimilarRowProps) {
  if (items.length === 0) return null;
  return (
    <div className="px-6 pb-10">
      <h2 className="text-lg font-semibold text-white mb-4">More Like This</h2>
      <div className="flex gap-3 overflow-x-auto pb-2 scrollbar-hide lg:grid lg:grid-cols-5 lg:overflow-visible xl:grid-cols-6 2xl:grid-cols-8">
        {items.map((media) => (
          <div key={`${media.mediaType}-${media.id}`} className="shrink-0 w-52 lg:w-auto lg:shrink">
            <MediaCard media={media} size="md" showPlex={showPlex} showJellyfin={showJellyfin} />
          </div>
        ))}
      </div>
    </div>
  );
}
