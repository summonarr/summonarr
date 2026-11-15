"use client";

// Person detail view — header (photo, name, known-for, birth/death, expandable
// bio) + a filmography grid of MediaCards (availability badges + requesting for
// free, off the enriched credits). Dates are formatted UTC-pinned deterministically
// so SSR and hydration agree — no Date.now()/locale drift (guardrail 16). Cards
// self-navigate to /movie|/tv detail via MediaCard's router push.

import { useMemo, useState } from "react";
import Image from "next/image";
import { User } from "@/components/icons";
import { MediaCard } from "@/components/media/media-card";
import { EmptyState } from "@/components/ui/design";
import { profileUrl, type PersonDetails, type PersonCredit, type TmdbMedia } from "@/lib/tmdb-types";
import { useLocale, useT } from "@/components/i18n/i18n-provider";

// "YYYY-MM-DD" → "June 9, 1963", pinned to UTC + the active UI locale (the
// same value on the server and the client) so both produce identical text.
function fmtDate(iso: string | null, locale: string): string | null {
  if (!iso) return null;
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(locale, { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

// TMDB's known_for_department values → i18n keys. Anything unlisted is shown
// as TMDB sent it.
const DEPARTMENT_KEYS: Record<string, string> = {
  Acting: "detail.person.department.acting",
  Directing: "detail.person.department.directing",
  Writing: "detail.person.department.writing",
  Production: "detail.person.department.production",
  Sound: "detail.person.department.sound",
  Camera: "detail.person.department.camera",
  Editing: "detail.person.department.editing",
  Art: "detail.person.department.art",
  "Costume & Make-Up": "detail.person.department.costume",
  "Visual Effects": "detail.person.department.visualEffects",
  Lighting: "detail.person.department.lighting",
  Crew: "detail.person.department.crew",
};

// A filmography credit is a subset of TmdbMedia + `character`; fill the required
// TmdbMedia fields the credit lacks so MediaCard can render it. Every other
// field — the ratings included — is carried by the spread, so a new rating
// field on the credit reaches the card without an edit here. The token rides
// MediaCard's own prop, not the media object.
function toMedia({ character: _character, requestToken: _requestToken, ...credit }: PersonCredit): TmdbMedia {
  return {
    ...credit,
    overview: "",
    backdropPath: null,
    releaseDate: null,
    releaseYear: credit.releaseYear || null,
  };
}

// The filmography filter pills, in order; a type with no credits is hidden.
type CreditFilter = "all" | "movie" | "tv";
const FILTER_LABELS: Record<CreditFilter, string> = {
  all: "detail.person.filterAll",
  movie: "detail.person.filterMovies",
  tv: "detail.person.filterTv",
};

const BIO_CLAMP = 360;

// Photo, name, department, birth/death and the expandable biography.
function PersonHeader({ person }: { person: PersonDetails }) {
  const t = useT();
  const locale = useLocale();
  const [bioExpanded, setBioExpanded] = useState(false);
  const born = fmtDate(person.birthday, locale);
  const died = fmtDate(person.deathday, locale);
  const departmentKey = person.knownForDepartment
    ? DEPARTMENT_KEYS[person.knownForDepartment]
    : undefined;
  const bio = person.biography?.trim() ?? "";
  const bioIsLong = bio.length > BIO_CLAMP;
  const bioText = bioExpanded || !bioIsLong ? bio : `${bio.slice(0, BIO_CLAMP).trimEnd()}…`;
  const photo = profileUrl(person.profilePath, "w342");

  // No horizontal padding anywhere on this page: unlike movie/tv it is not
  // bled to the viewport edge, so <main>'s own padding is the inset.
  return (
    <div style={{ display: "flex", gap: 20, padding: "16px 0 24px", flexWrap: "wrap" }}>
      <div
        className="relative shrink-0 overflow-hidden"
        style={{ width: 120, height: 180, borderRadius: 8, background: "var(--ds-bg-3)" }}
      >
        {photo ? (
          <Image
            src={photo}
            alt={person.name}
            fill
            sizes="120px"
            className="object-cover"
          />
        ) : (
          <div
            className="absolute inset-0 flex items-center justify-center"
            style={{ color: "var(--ds-fg-subtle)" }}
          >
            <User style={{ width: 36, height: 36 }} />
          </div>
        )}
      </div>

      <div style={{ flex: 1, minWidth: 260 }}>
        <h1
          className="font-semibold"
          style={{ fontSize: 32, letterSpacing: "-0.025em", lineHeight: 1.08, color: "var(--ds-fg)", margin: "0 0 4px" }}
        >
          {person.name}
        </h1>
        {person.knownForDepartment && (
          <div className="ds-mono" style={{ fontSize: 12, color: "var(--ds-fg-subtle)", marginBottom: 10 }}>
            {departmentKey ? t(departmentKey) : person.knownForDepartment}
          </div>
        )}
        {(born || died || person.placeOfBirth) && (
          <div style={{ fontSize: 12.5, color: "var(--ds-fg-muted)", marginBottom: 12, lineHeight: 1.7 }}>
            {born && <div>{t("detail.person.born", { date: born })}</div>}
            {died && <div>{t("detail.person.died", { date: died })}</div>}
            {person.placeOfBirth && <div>{person.placeOfBirth}</div>}
          </div>
        )}
        {bio && (
          <p style={{ fontSize: 13.5, color: "var(--ds-fg-muted)", lineHeight: 1.65, margin: 0, maxWidth: 720 }}>
            {bioText}{" "}
            {bioIsLong && (
              <button
                type="button"
                onClick={() => setBioExpanded((v) => !v)}
                className="hover:underline"
                style={{ background: "none", border: 0, color: "var(--ds-accent-text)", fontSize: 13, padding: "4px 0" }}
              >
                {bioExpanded ? t("detail.person.showLess") : t("detail.person.showMore")}
              </button>
            )}
          </p>
        )}
      </div>
    </div>
  );
}

export function PersonView({
  person,
  showPlex,
  showJellyfin,
  canRequestMovie,
  canRequestTv,
}: {
  person: PersonDetails;
  showPlex: boolean;
  showJellyfin: boolean;
  canRequestMovie?: boolean;
  canRequestTv?: boolean;
}) {
  const t = useT();
  const [filter, setFilter] = useState<CreditFilter>("all");

  // One media object per credit for as long as `person.credits` is the same
  // list: a fresh object per render defeated memo(MediaCard), so the bio toggle
  // or a filter switch re-rendered every card.
  const { entries, movieCount, tvCount } = useMemo(() => {
    const list: { credit: PersonCredit; media: TmdbMedia }[] = [];
    let movies = 0;
    let tv = 0;
    for (const c of person.credits) {
      list.push({ credit: c, media: toMedia(c) });
      if (c.mediaType === "movie") movies++;
      else if (c.mediaType === "tv") tv++;
    }
    return { entries: list, movieCount: movies, tvCount: tv };
  }, [person.credits]);
  const shown = filter === "all" ? entries : entries.filter((e) => e.credit.mediaType === filter);

  return (
    <div className="ds-page-enter">
      <PersonHeader person={person} />

      <section style={{ padding: "0 0 32px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
          <h2 className="font-semibold" style={{ fontSize: 15, letterSpacing: "-0.01em", color: "var(--ds-fg)", margin: 0 }}>
            {t("detail.person.knownFor")}
          </h2>
          <div style={{ display: "inline-flex", gap: 6 }}>
            {(Object.keys(FILTER_LABELS) as CreditFilter[]).map((val) => {
              const count = val === "all" ? person.credits.length : val === "movie" ? movieCount : tvCount;
              if (val !== "all" && count === 0) return null;
              const active = filter === val;
              return (
                <button
                  key={val}
                  type="button"
                  onClick={() => setFilter(val)}
                  aria-pressed={active}
                  className="ds-mono ds-hover-tint"
                  style={{
                    fontSize: 12,
                    minHeight: 32,
                    padding: "6px 12px",
                    borderRadius: 999,
                    border: "1px solid var(--ds-border)",
                    background: active ? "var(--ds-accent)" : "var(--ds-bg-2)",
                    color: active ? "var(--ds-accent-fg)" : "var(--ds-fg-muted)",
                  }}
                >
                  {t(FILTER_LABELS[val])} {count}
                </button>
              );
            })}
          </div>
        </div>

        {shown.length === 0 ? (
          <EmptyState title={t("detail.person.noTitles")} />
        ) : (
          <div className="ds-media-grid">
            {shown.map(({ credit: c, media }) => (
              <MediaCard
                // Same identity key as every other MediaCard grid. An index in the
                // key remounted every card on a filter toggle and dropped a
                // just-made request's local state; getPersonDetails dedupes
                // credits per (mediaType, id) so this can't collide.
                key={`${c.mediaType}-${c.id}`}
                media={media}
                size="md"
                requestToken={c.requestToken}
                showPlex={showPlex}
                showJellyfin={showJellyfin}
                canRequest={c.mediaType === "movie" ? canRequestMovie : canRequestTv}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
