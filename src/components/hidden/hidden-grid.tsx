"use client";

import { useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { posterUrl } from "@/lib/tmdb-types";
import { X, Film, Tv2, EyeOff } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import { EmptyState } from "@/components/ui/design";

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
    setItems((cur) => cur.filter((x) => `${x.tmdbId}:${x.mediaType}` !== key)); // optimistic
    // Roll back only THIS item — restoring a stale whole-list snapshot would
    // resurrect other items whose concurrent DELETE already succeeded.
    const restore = () =>
      setItems((cur) => (cur.some((x) => `${x.tmdbId}:${x.mediaType}` === key) ? cur : [...cur, it]));
    try {
      const res = await fetch(
        withBasePath(`/api/hidden?tmdbId=${it.tmdbId}&mediaType=${it.mediaType}`),
        { method: "DELETE" },
      );
      if (!res.ok) restore();
    } catch {
      restore();
    } finally {
      setRemoving(null);
    }
  }

  if (items.length === 0) {
    return (
      <EmptyState
        icon={EyeOff}
        title="Nothing hidden"
        description={
          <>
            Use &ldquo;Not interested&rdquo; on a movie or TV page to keep it out of your discovery.
          </>
        }
      />
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
            <Link href={href} className="block group">
              <div
                className="ds-card-lift relative overflow-hidden border border-[var(--ds-border)]"
                style={{ aspectRatio: "2 / 3", borderRadius: 8, background: "var(--ds-bg-3)", opacity: 0.75 }}
              >
                {poster ? (
                  <Image src={poster} alt={it.title} fill className="object-cover" sizes="140px" />
                ) : (
                  <div className="flex items-center justify-center h-full" style={{ color: "var(--ds-fg-subtle)" }}>
                    {it.mediaType === "MOVIE" ? <Film style={{ width: 28, height: 28 }} /> : <Tv2 style={{ width: 28, height: 28 }} />}
                  </div>
                )}
              </div>
              <div
                className="ds-mono line-clamp-2 transition-colors group-hover:text-[var(--ds-fg)]"
                style={{ fontSize: 11.5, color: "var(--ds-fg-muted)", marginTop: 6, lineHeight: 1.3 }}
              >
                {it.title}
              </div>
            </Link>
            <button
              type="button"
              onClick={() => unhide(it)}
              disabled={removing === key}
              aria-label={`Unhide ${it.title}`}
              title="Unhide"
              className="ds-hover-tint absolute"
              style={{
                top: 6,
                right: 6,
                width: 32,
                height: 32,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                borderRadius: 6,
                background: "color-mix(in oklab, var(--ds-bg) 70%, transparent)",
                color: "var(--ds-fg)",
                border: "1px solid var(--ds-border)",
                cursor: removing === key ? "progress" : undefined,
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
