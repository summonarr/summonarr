import { MediaCard } from "./media-card";
import type { TmdbMedia } from "@/lib/tmdb-types";

interface CollectionRowProps {
  collectionName: string;
  items: TmdbMedia[];
  currentId: number;
  showPlex?: boolean;
  showJellyfin?: boolean;
}

export function CollectionRow({
  collectionName,
  items,
  currentId,
  showPlex,
  showJellyfin,
}: CollectionRowProps) {
  const others = items.filter((m) => m.id !== currentId);
  if (others.length === 0) return null;
  return (
    <section style={{ padding: "0 16px 32px" }}>
      <h2
        className="section-title font-semibold"
        style={{
          fontSize: 15,
          letterSpacing: "-0.01em",
          color: "var(--ds-fg)",
          margin: "0 0 12px",
        }}
      >
        {collectionName}
      </h2>
      <div className="ds-media-grid">
        {others.map((media) => (
          <MediaCard
            key={`${media.mediaType}-${media.id}`}
            media={media}
            size="md"
            showPlex={showPlex}
            showJellyfin={showJellyfin}
          />
        ))}
      </div>
    </section>
  );
}
