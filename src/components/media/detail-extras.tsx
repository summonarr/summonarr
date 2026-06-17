import Image from "next/image";
import Link from "next/link";
import type { TmdbMedia } from "@/lib/tmdb-types";
import { Chip } from "@/components/ui/design";

const PROVIDER_LOGO_BASE = "https://image.tmdb.org/t/p/w92";

const PROVIDER_GROUP_LABEL: Record<NonNullable<TmdbMedia["watchProviders"]>[number]["type"], string> = {
  stream: "Stream",
  rent: "Rent",
  buy: "Buy",
};

/**
 * Block-level supplementary metadata for the movie/TV detail pages: streaming availability
 * (JustWatch data via TMDB), keyword tags, and an official-site link. Rendered as a server
 * component below the hero. Each section self-hides when its data is absent.
 */
export function DetailExtras({ media, mediaType }: { media: TmdbMedia; mediaType: "movie" | "tv" }) {
  const browseBase = mediaType === "tv" ? "/tv" : "/movies";
  const providers = media.watchProviders ?? [];
  // keywordList carries id+name (media.keywords is the names-only back-compat array).
  const keywords = media.keywordList ?? [];
  const homepage = media.homepage ?? null;
  const hasProviders = providers.length > 0;
  const hasKeywords = keywords.length > 0;

  if (!hasProviders && !hasKeywords && !homepage) return null;

  // Group providers by offering type, preserving the stream → rent → buy order.
  const grouped: { type: NonNullable<TmdbMedia["watchProviders"]>[number]["type"]; items: typeof providers }[] = [];
  for (const type of ["stream", "rent", "buy"] as const) {
    const items = providers.filter((p) => p.type === type);
    if (items.length) grouped.push({ type, items });
  }

  return (
    <section
      className="flex flex-col"
      style={{ padding: "0 16px 32px", gap: 20 }}
    >
      {hasProviders && (
        <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <h2 className="ds-mono" style={{ fontSize: 11, letterSpacing: "0.04em", color: "var(--ds-fg-subtle)", margin: 0, textTransform: "uppercase" }}>
            Where to watch
          </h2>
          <div className="flex flex-wrap items-start" style={{ gap: 18 }}>
            {grouped.map((g) => (
              <div key={g.type} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <span className="ds-mono" style={{ fontSize: 10.5, color: "var(--ds-fg-subtle)" }}>{PROVIDER_GROUP_LABEL[g.type]}</span>
                <div className="flex flex-wrap items-center" style={{ gap: 8 }}>
                  {g.items.map((p) => (
                    <div
                      key={`${g.type}-${p.name}`}
                      title={p.name}
                      className="relative overflow-hidden shrink-0"
                      style={{ width: 36, height: 36, borderRadius: 8, border: "1px solid var(--ds-border)", background: "var(--ds-bg-3)" }}
                    >
                      {p.logoPath ? (
                        <Image src={`${PROVIDER_LOGO_BASE}${p.logoPath}`} alt={p.name} fill className="object-cover" sizes="36px" />
                      ) : (
                        <span className="flex items-center justify-center h-full w-full" style={{ fontSize: 9, color: "var(--ds-fg-muted)" }}>
                          {p.name.slice(0, 3)}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {hasKeywords && (
        <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <h2 className="ds-mono" style={{ fontSize: 11, letterSpacing: "0.04em", color: "var(--ds-fg-subtle)", margin: 0, textTransform: "uppercase" }}>
            Keywords
          </h2>
          <div className="flex flex-wrap" style={{ gap: 6 }}>
            {keywords.map((k) => (
              <Link
                key={k.id}
                href={`${browseBase}?keywordId=${k.id}&keywordName=${encodeURIComponent(k.name)}`}
                aria-label={`Browse ${mediaType === "tv" ? "TV" : "movies"} tagged ${k.name}`}
              >
                <Chip className="ds-chip-link">{k.name}</Chip>
              </Link>
            ))}
          </div>
        </section>
      )}

      {homepage && (
        <a
          href={homepage}
          target="_blank"
          rel="noopener noreferrer"
          className="ds-mono"
          style={{ fontSize: 11.5, color: "var(--ds-accent)", textDecoration: "none", width: "fit-content" }}
        >
          Official site ↗
        </a>
      )}
    </section>
  );
}
