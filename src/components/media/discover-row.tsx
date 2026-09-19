import Link from "next/link";
import { ChevronRight } from "@/components/icons";
import { MediaCard } from "./media-card";
import { SectionHeader } from "@/components/ui/design";
import type { TmdbMedia } from "@/lib/tmdb-types";

interface DiscoverRowProps {
  title: string;
  items: TmdbMedia[];
  showPlex?: boolean;
  showJellyfin?: boolean;
  subtitle?: string;
  seeAllHref?: string;
  /** True while the page's "Hide Available" toggle is on. An empty rail then
      keeps its header and says why it is empty instead of vanishing — with the
      toggle on, the home page could otherwise collapse to a lone header. */
  hideAvailable?: boolean;
}

export function DiscoverRow({
  title,
  items,
  showPlex,
  showJellyfin,
  subtitle,
  seeAllHref,
  hideAvailable,
}: DiscoverRowProps) {
  if (items.length === 0 && !hideAvailable) return null;
  return (
    <section style={{ marginBottom: 36 }}>
      <SectionHeader
        title={title}
        subtitle={subtitle}
        right={
          seeAllHref ? (
            <Link
              href={seeAllHref}
              className="ds-hover-tint inline-flex items-center gap-1 font-medium"
              style={{
                fontSize: 12,
                color: "var(--ds-fg-muted)",
                padding: "4px 8px",
                minHeight: 32,
                borderRadius: 6,
              }}
            >
              See all
              <ChevronRight style={{ width: 12, height: 12 }} />
            </Link>
          ) : undefined
        }
      />
      {items.length === 0 ? (
        <p
          className="ds-mono m-0"
          style={{ fontSize: 12, color: "var(--ds-fg-subtle)" }}
        >
          Everything here is already on your server.
        </p>
      ) : (
        <div className="ds-media-grid">
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
      )}
    </section>
  );
}
