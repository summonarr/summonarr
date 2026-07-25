"use client";

import Image from "next/image";
import Link from "next/link";
import { User } from "@/components/icons";
import type { CastMember } from "@/lib/tmdb-types";

interface CastSectionProps {
  cast: CastMember[];
}

// Cast grid; each member links to their /person/[id] page (filmography with
// availability badges + inline requesting). This replaced the old in-place modal
// — the page is deep-linkable, shareable, and roomier for a full filmography.
// (Next's configured basePath auto-prefixes the Link href, so no withBasePath here.)
export function CastSection({ cast }: CastSectionProps) {
  return (
    <section style={{ padding: "0 16px 32px" }}>
      <h2
        className="section-title font-semibold"
        style={{ fontSize: 15, letterSpacing: "-0.01em", color: "var(--ds-fg)", margin: "0 0 12px" }}
      >
        Cast
      </h2>
      <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 xl:grid-cols-12 2xl:grid-cols-16 gap-3">
        {cast.map((member) => (
          <Link
            key={member.id}
            href={`/person/${member.id}`}
            className="flex flex-col items-center text-center group rounded-lg focus-visible:outline-none focus-visible:ring-2"
            style={{ gap: 6, padding: 4, color: "var(--ds-fg)", textDecoration: "none" }}
          >
            <div
              className="relative shrink-0 overflow-hidden rounded-full transition-all"
              style={{ width: 56, height: 56, background: "var(--ds-bg-3)" }}
            >
              {member.profilePath ? (
                <Image
                  src={`https://image.tmdb.org/t/p/w185${member.profilePath}`}
                  alt={member.name}
                  fill
                  sizes="56px"
                  className="object-cover"
                />
              ) : (
                <div className="absolute inset-0 flex items-center justify-center" style={{ color: "var(--ds-fg-subtle)" }}>
                  <User style={{ width: 22, height: 22 }} />
                </div>
              )}
            </div>
            <div>
              <p
                className="font-medium leading-tight line-clamp-2 transition-colors group-hover:text-[var(--ds-accent)]"
                style={{ fontSize: 12, color: "var(--ds-fg)" }}
              >
                {member.name}
              </p>
              {member.character && (
                <p
                  className="leading-tight line-clamp-1"
                  style={{ fontSize: 10, color: "var(--ds-fg-subtle)", marginTop: 2 }}
                >
                  {member.character}
                </p>
              )}
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}
