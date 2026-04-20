import { MediaCard } from "./media-card";
import type { TmdbMedia } from "@/lib/tmdb-types";

interface CollectionRowProps {
  collectionName: string;
  items: TmdbMedia[];
  currentId: number;
  showPlex?: boolean;
  showJellyfin?: boolean;
}

export function CollectionRow({ collectionName, items, currentId, showPlex, showJellyfin }: CollectionRowProps) {
  const others = items.filter((m) => m.id !== currentId);
  if (others.length === 0) return null;
  return (
    <div className="px-6 pb-10">
      <h2 className="text-lg font-semibold text-white mb-4">{collectionName}</h2>
      <div className="flex gap-3 overflow-x-auto pb-2 scrollbar-hide lg:grid lg:grid-cols-6 lg:overflow-visible xl:grid-cols-8 2xl:grid-cols-10">
        {others.map((media) => (
          <div key={`${media.mediaType}-${media.id}`} className="shrink-0 w-44 lg:w-auto lg:shrink">
            <MediaCard media={media} size="md" showPlex={showPlex} showJellyfin={showJellyfin} />
          </div>
        ))}
      </div>
    </div>
  );
}
