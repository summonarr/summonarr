"use client";

// Person detail view — header (photo, name, known-for, birth/death, expandable
// bio) + a filmography grid of MediaCards (availability badges + requesting for
// free, off the enriched credits). Dates are formatted UTC-pinned deterministically
// so SSR and hydration agree — no Date.now()/locale drift (guardrail 16). Cards
// self-navigate to /movie|/tv detail via MediaCard's router push.

import { useState } from "react";
import Image from "next/image";
import { User } from "@/components/icons";
import { MediaCard } from "@/components/media/media-card";
import type { PersonDetails, PersonCredit, TmdbMedia } from "@/lib/tmdb-types";

// "YYYY-MM-DD" → "June 9, 1963", pinned to UTC + en-US so server and client
// produce identical text.
function fmtDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

// A filmography credit is a subset of TmdbMedia + `character`; fill the required
// TmdbMedia fields the credit lacks so MediaCard can render it.
function toMedia(c: PersonCredit): TmdbMedia {
  return {
    id: c.id,
    mediaType: c.mediaType,
    title: c.title,
    overview: "",
    posterPath: c.posterPath,
    backdropPath: null,
    releaseDate: null,
    releaseYear: c.releaseYear || null,
    voteAverage: c.voteAverage,
    plexAvailable: c.plexAvailable,
    jellyfinAvailable: c.jellyfinAvailable,
    arrPending: c.arrPending,
    requested: c.requested,
    requestedByMe: c.requestedByMe,
    blacklisted: c.blacklisted,
    imdbId: c.imdbId,
    imdbRating: c.imdbRating,
    imdbVotes: c.imdbVotes,
    rottenTomatoes: c.rottenTomatoes,
    rtAudienceScore: c.rtAudienceScore,
    metacritic: c.metacritic,
    traktRating: c.traktRating,
    letterboxdRating: c.letterboxdRating,
    mdblistScore: c.mdblistScore,
    malRating: c.malRating,
    rogerEbertRating: c.rogerEbertRating,
  };
}

const BIO_CLAMP = 360;

export function PersonView({
  person,
  showPlex,
  showJellyfin,
}: {
  person: PersonDetails;
  showPlex: boolean;
  showJellyfin: boolean;
}) {
  const [filter, setFilter] = useState<"all" | "movie" | "tv">("all");
  const [bioExpanded, setBioExpanded] = useState(false);

  const movieCount = person.credits.filter((c) => c.mediaType === "movie").length;
  const tvCount = person.credits.filter((c) => c.mediaType === "tv").length;
  const shown = filter === "all" ? person.credits : person.credits.filter((c) => c.mediaType === filter);

  const born = fmtDate(person.birthday);
  const died = fmtDate(person.deathday);
  const bio = person.biography?.trim() ?? "";
  const bioIsLong = bio.length > BIO_CLAMP;
  const bioText = bioExpanded || !bioIsLong ? bio : `${bio.slice(0, BIO_CLAMP).trimEnd()}…`;

  return (
    <div>
      <div style={{ display: "flex", gap: 20, padding: "16px 16px 24px", flexWrap: "wrap" }}>
        <div
          className="relative shrink-0 overflow-hidden"
          style={{ width: 120, height: 180, borderRadius: 12, background: "var(--ds-bg-3)" }}
        >
          {person.profilePath ? (
            <Image
              src={`https://image.tmdb.org/t/p/w342${person.profilePath}`}
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
          <h1 style={{ fontSize: 26, fontWeight: 700, letterSpacing: "-0.02em", color: "var(--ds-fg)", margin: "0 0 4px" }}>
            {person.name}
          </h1>
          {person.knownForDepartment && (
            <div className="ds-mono" style={{ fontSize: 12, color: "var(--ds-fg-subtle)", marginBottom: 10 }}>
              {person.knownForDepartment}
            </div>
          )}
          {(born || died || person.placeOfBirth) && (
            <div style={{ fontSize: 12.5, color: "var(--ds-fg-muted)", marginBottom: 12, lineHeight: 1.7 }}>
              {born && <div>Born {born}</div>}
              {died && <div>Died {died}</div>}
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
                  style={{ background: "none", border: 0, color: "var(--ds-accent)", cursor: "pointer", fontSize: 13, padding: 0 }}
                >
                  {bioExpanded ? "Show less" : "Show more"}
                </button>
              )}
            </p>
          )}
        </div>
      </div>

      <section style={{ padding: "0 16px 32px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14, flexWrap: "wrap" }}>
          <h2 className="section-title font-semibold" style={{ fontSize: 15, letterSpacing: "-0.01em", color: "var(--ds-fg)", margin: 0 }}>
            Known for
          </h2>
          <div style={{ display: "inline-flex", gap: 6 }}>
            {(
              [
                ["all", "All", person.credits.length],
                ["movie", "Movies", movieCount],
                ["tv", "TV", tvCount],
              ] as const
            ).map(([val, label, count]) => {
              if (val !== "all" && count === 0) return null;
              const active = filter === val;
              return (
                <button
                  key={val}
                  type="button"
                  onClick={() => setFilter(val)}
                  className="ds-mono"
                  style={{
                    fontSize: 12,
                    padding: "4px 10px",
                    borderRadius: 999,
                    border: "1px solid var(--ds-border)",
                    background: active ? "var(--ds-accent)" : "var(--ds-bg-2)",
                    color: active ? "#fff" : "var(--ds-fg-muted)",
                    cursor: "pointer",
                  }}
                >
                  {label} {count}
                </button>
              );
            })}
          </div>
        </div>

        {shown.length === 0 ? (
          <div style={{ fontSize: 13, color: "var(--ds-fg-subtle)", padding: "20px 0" }}>No titles to show.</div>
        ) : (
          <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8 gap-3">
            {shown.map((c) => (
              <MediaCard
                // Same identity key as every other MediaCard grid. An index in the
                // key remounted every card on a filter toggle and dropped a
                // just-made request's local state; getPersonDetails dedupes
                // credits per (mediaType, id) so this can't collide.
                key={`${c.mediaType}-${c.id}`}
                media={toMedia(c)}
                requestToken={c.requestToken}
                showPlex={showPlex}
                showJellyfin={showJellyfin}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
