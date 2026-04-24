import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { MediaCard } from "./media-card";
import type { TmdbMedia } from "@/lib/tmdb-types";

interface DiscoverRowProps {
  title: string;
  items: TmdbMedia[];
  showPlex?: boolean;
  showJellyfin?: boolean;
  subtitle?: string;
  seeAllHref?: string;
}

export function DiscoverRow({
  title,
  items,
  showPlex,
  showJellyfin,
  subtitle,
  seeAllHref,
}: DiscoverRowProps) {
  if (items.length === 0) return null;
  return (
    <section style={{ marginBottom: 36 }}>
      <div className="flex items-end mb-3">
        <div className="min-w-0">
          <h2
            className="section-title m-0 font-semibold"
            style={{
              fontSize: 15,
              letterSpacing: "-0.01em",
              color: "var(--ds-fg)",
            }}
          >
            {title}
          </h2>
          {subtitle && (
            <p
              className="ds-mono m-0"
              style={{
                fontSize: 11,
                color: "var(--ds-fg-subtle)",
                marginTop: 2,
              }}
            >
              {subtitle}
            </p>
          )}
        </div>
        {seeAllHref && (
          <Link
            href={seeAllHref}
            className="ml-auto inline-flex items-center gap-1 font-medium transition-colors"
            style={{
              fontSize: 12,
              color: "var(--ds-fg-muted)",
              padding: "4px 8px",
              borderRadius: 6,
            }}
          >
            See all
            <ChevronRight style={{ width: 12, height: 12 }} />
          </Link>
        )}
      </div>
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
    </section>
  );
}
