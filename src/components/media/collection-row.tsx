import { MediaCard } from "./media-card";
import { CollectionRequestAllButton } from "./collection-request-all";
import type { TmdbMedia } from "@/lib/tmdb-types";
import { SectionHeader } from "@/components/ui/design";

interface CollectionRowProps {
  collectionName: string;
  items: TmdbMedia[];
  // `${mediaType}:${id}` of titles the viewer can never re-request (see
  // permanentlyDeclinedKeys); "Request all" leaves them out.
  declinedKeys?: string[];
  currentId: number;
  showPlex?: boolean;
  showJellyfin?: boolean;
  canRequest?: boolean;
}

export function CollectionRow({
  collectionName,
  items,
  declinedKeys,
  currentId,
  showPlex,
  showJellyfin,
  canRequest,
}: CollectionRowProps) {
  const others = items.filter((m) => m.id !== currentId);
  if (others.length === 0) return null;
  return (
    <section className="ds-detail-section">
      {/* The shared heading primitive (title + right slot), not a hand copy of
          its styles — the copies drift the first time SectionHeader changes. */}
      <SectionHeader
        title={collectionName}
        right={<CollectionRequestAllButton items={others} declinedKeys={declinedKeys} canRequest={canRequest} />}
      />
      <div className="ds-media-grid">
        {others.map((media) => (
          <MediaCard
            key={`${media.mediaType}-${media.id}`}
            media={media}
            size="md"
            showPlex={showPlex}
            showJellyfin={showJellyfin}
            canRequest={canRequest}
          />
        ))}
      </div>
    </section>
  );
}
