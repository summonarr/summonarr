import Link from "next/link";
import { ChevronRight } from "@/components/icons";
import { MediaCard } from "./media-card";
import { SectionHeader } from "@/components/ui/design";
import type { TmdbMedia } from "@/lib/tmdb-types";
import { getTranslator } from "@/lib/i18n/server";

interface DiscoverRowProps {
  title: string;
  items: TmdbMedia[];
  showPlex?: boolean;
  showJellyfin?: boolean;
  subtitle?: string;
  seeAllHref?: string;
  /** True when the page's "Hide Available" toggle is what emptied this rail
      (every title it had is already available). The rail then keeps its header
      and says so instead of vanishing — with the toggle on, the home page could
      otherwise collapse to a lone header. Any OTHER empty rail (a failed TMDB
      call, no For You shelf yet) still disappears: the message would be false. */
  allAvailable?: boolean;
}

// Server component (async for the request translator); only the home page renders it.
export async function DiscoverRow({
  title,
  items,
  showPlex,
  showJellyfin,
  subtitle,
  seeAllHref,
  allAvailable,
}: DiscoverRowProps) {
  if (items.length === 0 && !allAvailable) return null;
  const t = await getTranslator();
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
              {t("media.row.seeAll")}
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
          {t("media.row.allAvailable")}
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
