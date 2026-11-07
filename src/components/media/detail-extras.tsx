import Image from "next/image";
import Link from "next/link";
import { logoUrl, type TmdbMedia } from "@/lib/tmdb-types";
import { Chip } from "@/components/ui/design";
import { safeExternalHref } from "@/lib/safe-url";
import { getTranslator, getLocale } from "@/lib/i18n/server";
import { formatReleaseDate } from "@/lib/format-release-date";

// One extras group: a small sub-label over its content. h3, not h2: these sit
// below the page's real section headings (Cast, Seasons, More Like This).
function ExtrasGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <h3 className="ds-mono" style={{ fontSize: 11, letterSpacing: "0.04em", color: "var(--ds-fg-subtle)", margin: 0, textTransform: "uppercase" }}>
        {title}
      </h3>
      {children}
    </section>
  );
}

// i18n keys (detail.json), translated at render.
const PROVIDER_GROUP_LABEL: Record<NonNullable<TmdbMedia["watchProviders"]>[number]["type"], string> = {
  stream: "detail.providers.stream",
  rent: "detail.providers.rent",
  buy: "detail.providers.buy",
};

/**
 * Block-level supplementary metadata for the movie/TV detail pages: streaming availability
 * (JustWatch data via TMDB), keyword tags, and an official-site link. Rendered as a server
 * component below the hero. Each section self-hides when its data is absent.
 */
export async function DetailExtras({ media, mediaType }: { media: TmdbMedia; mediaType: "movie" | "tv" }) {
  const browseBase = mediaType === "tv" ? "/tv" : "/movies";
  const providers = media.watchProviders ?? [];
  // keywordList carries id+name (media.keywords is the names-only back-compat array).
  const keywords = media.keywordList ?? [];
  // Validate before render — TMDB homepage is third-party data; a javascript: URL
  // in an href would execute on click. safeExternalHref returns only http(s) URLs.
  const homepage = safeExternalHref(media.homepage) ?? null;
  const hasProviders = providers.length > 0;
  const hasKeywords = keywords.length > 0;
  // Studios/networks carry TMDB ids only on titles cached after studioList landed;
  // older cache rows render no links until they refresh.
  const studioList = media.studioList ?? [];
  const hasStudios = studioList.length > 0;
  // Movies: TMDB's Digital (type 4) / Physical (type 5) dates, Digital falling
  // back to MDBList's. TV: TMDB has no release types for TV, so Digital is
  // MDBList's alone and Physical never has a source.
  const digitalRaw = (mediaType === "movie" ? media.digitalReleaseDate : null) ?? media.releasedDigital ?? null;
  const physicalRaw = mediaType === "movie" ? (media.physicalReleaseDate ?? null) : null;
  const hasReleases = !!(digitalRaw || physicalRaw);

  if (!hasProviders && !hasKeywords && !hasStudios && !homepage && !hasReleases) return null;
  const t = await getTranslator();
  const locale = await getLocale();
  const releases = [
    { label: t("detail.release.digital"), date: formatReleaseDate(digitalRaw, locale) },
    { label: t("detail.release.physical"), date: formatReleaseDate(physicalRaw, locale) },
  ].filter((r): r is { label: string; date: string } => r.date !== null);

  // Group providers by offering type, preserving the stream → rent → buy order.
  const grouped: { type: NonNullable<TmdbMedia["watchProviders"]>[number]["type"]; items: typeof providers }[] = [];
  for (const type of ["stream", "rent", "buy"] as const) {
    const items = providers.filter((p) => p.type === type);
    if (items.length) grouped.push({ type, items });
  }

  return (
    <section
      className="ds-detail-section flex flex-col"
      style={{ gap: 20 }}
    >
      {releases.length > 0 && (
        <ExtrasGroup title={t("detail.releaseDates")}>
          <dl className="flex flex-wrap items-start" style={{ gap: 18, margin: 0 }}>
            {releases.map((r) => (
              <div key={r.label} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <dt className="ds-mono" style={{ fontSize: 10.5, color: "var(--ds-fg-subtle)" }}>{r.label}</dt>
                <dd style={{ fontSize: 13.5, color: "var(--ds-fg)", margin: 0 }}>{r.date}</dd>
              </div>
            ))}
          </dl>
        </ExtrasGroup>
      )}

      {hasProviders && (
        <ExtrasGroup title={t("detail.whereToWatch")}>
          <div className="flex flex-wrap items-start" style={{ gap: 18 }}>
            {grouped.map((g) => (
              <div key={g.type} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <span className="ds-mono" style={{ fontSize: 10.5, color: "var(--ds-fg-subtle)" }}>{t(PROVIDER_GROUP_LABEL[g.type])}</span>
                <div className="flex flex-wrap items-center" style={{ gap: 8 }}>
                  {g.items.map((p) => {
                    const logo = logoUrl(p.logoPath);
                    return (
                      <div
                        key={`${g.type}-${p.name}`}
                        title={p.name}
                        className="relative overflow-hidden shrink-0"
                        style={{ width: 36, height: 36, borderRadius: 8, border: "1px solid var(--ds-border)", background: "var(--ds-bg-3)" }}
                      >
                        {logo ? (
                          <Image src={logo} alt="" fill className="object-cover" sizes="36px" />
                        ) : (
                          <span aria-hidden="true" className="flex items-center justify-center h-full w-full" style={{ fontSize: 9, color: "var(--ds-fg-muted)" }}>
                            {p.name.slice(0, 3)}
                          </span>
                        )}
                        {/* The name travels with the tile (`title` is hover-only);
                            the logo/abbreviation are decorative beside it. */}
                        <span className="sr-only">{p.name}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </ExtrasGroup>
      )}

      {hasStudios && (
        <ExtrasGroup title={t("detail.studios")}>
          <div className="flex flex-wrap" style={{ gap: 6 }}>
            {studioList.map((s) => {
              // A network is TV-only; a company browses either type.
              const href = s.kind === "network"
                ? `/tv?networkId=${s.id}&networkName=${encodeURIComponent(s.name)}`
                : `${browseBase}?companyId=${s.id}&companyName=${encodeURIComponent(s.name)}`;
              return (
                <Link
                  key={`${s.kind}:${s.id}`}
                  href={href}
                  aria-label={t(mediaType === "tv" ? "detail.browseTvFrom" : "detail.browseMoviesFrom", { name: s.name })}
                >
                  <Chip className="ds-chip-link">{s.name}</Chip>
                </Link>
              );
            })}
          </div>
        </ExtrasGroup>
      )}

      {hasKeywords && (
        <ExtrasGroup title={t("detail.keywords")}>
          <div className="flex flex-wrap" style={{ gap: 6 }}>
            {keywords.map((k) => (
              <Link
                key={k.id}
                href={`${browseBase}?keywordId=${k.id}&keywordName=${encodeURIComponent(k.name)}`}
                aria-label={t(mediaType === "tv" ? "detail.browseTvTagged" : "detail.browseMoviesTagged", { keyword: k.name })}
              >
                <Chip className="ds-chip-link">{k.name}</Chip>
              </Link>
            ))}
          </div>
        </ExtrasGroup>
      )}

      {homepage && (
        <a
          href={homepage}
          target="_blank"
          rel="noopener noreferrer"
          className="ds-mono no-underline hover:underline"
          style={{ fontSize: 11.5, color: "var(--ds-accent-text)", width: "fit-content" }}
        >
          {t("detail.officialSite")} ↗
        </a>
      )}
    </section>
  );
}
