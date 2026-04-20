import { MediaCard } from "./media-card";
import type { TmdbMedia } from "@/lib/tmdb-types";

interface DiscoverRowProps {
  title: string;
  items: TmdbMedia[];
  showPlex?: boolean;
  showJellyfin?: boolean;
}

export function DiscoverRow({ title, items, showPlex, showJellyfin }: DiscoverRowProps) {
  if (items.length === 0) return null;
  return (
    <section className="mb-10">
      <h2 className="text-lg font-semibold text-white mb-4">{title}</h2>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-5">
        {items.map((media) => (
          <MediaCard
            key={`${media.mediaType}-${media.id}`}
            media={media}
            showPlex={showPlex}
            showJellyfin={showJellyfin}
            size="md"
          />
        ))}
      </div>
    </section>
  );
}
