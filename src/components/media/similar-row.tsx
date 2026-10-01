import { MediaCard } from "./media-card";
import type { TmdbMedia } from "@/lib/tmdb-types";
import { getTranslator } from "@/lib/i18n/server";

interface SimilarRowProps {
  items: TmdbMedia[];
  showPlex?: boolean;
  showJellyfin?: boolean;
}

// "More Like This" grid of recommended/similar titles on a detail page.
export async function SimilarRow({ items, showPlex, showJellyfin }: SimilarRowProps) {
  if (items.length === 0) return null;
  const t = await getTranslator();
  return (
    <section className="ds-detail-section">
      <h2
        className="font-semibold"
        style={{
          fontSize: 15,
          letterSpacing: "-0.01em",
          color: "var(--ds-fg)",
          margin: "0 0 12px",
        }}
      >
        {t("detail.moreLikeThis")}
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
