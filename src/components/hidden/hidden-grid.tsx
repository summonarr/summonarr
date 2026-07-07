"use client";

import { useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { posterUrl } from "@/lib/tmdb-types";
import { X, Film, Tv2 } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import { EmptyState } from "@/components/ui/empty-state";

export interface HiddenGridItem {
  tmdbId: number;
  mediaType: "MOVIE" | "TV";
  title: string;
  posterPath: string | null;
}

// Client grid for the /hidden page. Lists the user's "not interested" titles with
// an optimistic un-hide (X) that DELETEs the entry (restoring it to discovery).
export function HiddenGrid({ initialItems }: { initialItems: HiddenGridItem[] }) {
  const [items, setItems] = useState(initialItems);
  const [removing, setRemoving] = useState<string | null>(null);

  async function unhide(it: HiddenGridItem) {
    const key = `${it.tmdbId}:${it.mediaType}`;
    setRemoving(key);
    const prev = items;
    setItems((cur) => cur.filter((x) => `${x.tmdbId}:${x.mediaType}` !== key)); // optimistic
    try {
      const res = await fetch(
        withBasePath(`/api/hidden?tmdbId=${it.tmdbId}&mediaType=${it.mediaType}`),
        { method: "DELETE" },
      );
      if (!res.ok) setItems(prev); // rollback
    } catch {
      setItems(prev); // rollback
    } finally {
      setRemoving(null);
    }
  }

  if (items.length === 0) {
    return (
      <EmptyState>
        You haven&apos;t hidden anything. Use &ldquo;Not interested&rdquo; on a movie or TV page to keep it out of your discovery.
      </EmptyState>
    );
  }

  return (
    <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))" }}>
      {items.map((it) => {
        const key = `${it.tmdbId}:${it.mediaType}`;
        const href = it.mediaType === "MOVIE" ? `/movie/${it.tmdbId}` : `/tv/${it.tmdbId}`;
        const poster = posterUrl(it.posterPath, "w342");
        return (
          <div key={key} className="relative">
            <Link href={href} className="block">
              <div
                className="relative overflow-hidden"
                style={{ aspectRatio: "2 / 3", borderRadius: 8, background: "var(--ds-bg-3)", border: "1px solid var(--ds-border)", opacity: 0.75 }}
              >
                {poster ? (
                  <Image src={poster} alt={it.title} fill className="object-cover" sizes="140px" />
                ) : (
                  <div className="flex items-center justify-center h-full" style={{ color: "var(--ds-fg-subtle)" }}>
                    {it.mediaType === "MOVIE" ? <Film style={{ width: 28, height: 28 }} /> : <Tv2 style={{ width: 28, height: 28 }} />}
                  </div>
                )}
              </div>
              <div className="ds-mono" style={{ fontSize: 11.5, color: "var(--ds-fg-muted)", marginTop: 6, lineHeight: 1.3 }}>
                {it.title}
              </div>
            </Link>
            <button
              type="button"
              onClick={() => unhide(it)}
              disabled={removing === key}
              aria-label={`Un-hide ${it.title}`}
              title="Un-hide"
              className="absolute"
              style={{
                top: 6,
                right: 6,
                width: 26,
                height: 26,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                borderRadius: 6,
                background: "color-mix(in oklab, var(--ds-bg) 70%, transparent)",
                color: "var(--ds-fg)",
                border: "1px solid var(--ds-border)",
                cursor: removing === key ? "progress" : "pointer",
              }}
            >
              <X style={{ width: 14, height: 14 }} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
