import { MediaCard } from "./media-card";
import type { TmdbMedia } from "@/lib/tmdb-types";
import { getTranslator } from "@/lib/i18n/server";
import { SectionHeader } from "@/components/ui/design";

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
      {/* The shared heading primitive, not a hand copy of its styles — the
          copies drift the first time SectionHeader changes. */}
      <SectionHeader title={t("detail.moreLikeThis")} />
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
