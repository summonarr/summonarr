import { MediaCard } from "./media-card";
import { CollectionRequestAllButton } from "./collection-request-all";
import type { TmdbMedia } from "@/lib/tmdb-types";

interface CollectionRowProps {
  collectionName: string;
  items: TmdbMedia[];
  currentId: number;
  showPlex?: boolean;
  showJellyfin?: boolean;
  canRequest?: boolean;
}

export function CollectionRow({
  collectionName,
  items,
  currentId,
  showPlex,
  showJellyfin,
  canRequest,
}: CollectionRowProps) {
  const others = items.filter((m) => m.id !== currentId);
  if (others.length === 0) return null;
  return (
    <section style={{ padding: "0 16px 32px" }}>
      <div className="flex items-center justify-between gap-3" style={{ margin: "0 0 12px" }}>
        <h2
          className="section-title font-semibold"
          style={{
            fontSize: 15,
            letterSpacing: "-0.01em",
            color: "var(--ds-fg)",
            margin: 0,
          }}
        >
          {collectionName}
        </h2>
        <CollectionRequestAllButton items={others} canRequest={canRequest} />
      </div>
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
