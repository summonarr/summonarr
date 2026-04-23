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
        More Like This
      </h2>
      <div className="ds-media-grid">
        {items.map((media) => (
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
