"use client";

import { useState } from "react";
import { withBasePath } from "@/lib/base-path";
import { Ban, X, Loader2 } from "@/components/icons";

interface BlacklistRow {
  tmdbId: number;
  mediaType: "MOVIE" | "TV";
  title: string | null;
  reason: string | null;
  createdAt: string;
}

interface SearchResult {
  id: number;
  mediaType: "movie" | "tv";
  title: string;
  releaseYear?: string | null;
}

const rowKey = (tmdbId: number, mt: string) => `${tmdbId}:${mt}`;

export function BlacklistManager({ initial }: { initial: BlacklistRow[] }) {
  const [items, setItems] = useState<BlacklistRow[]>(initial);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  const blocked = new Set(items.map((i) => rowKey(i.tmdbId, i.mediaType)));

  async function runSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim()) {
      setResults([]);
      return;
    }
    setSearching(true);
    setError("");
    try {
      const res = await fetch(withBasePath(`/api/search?q=${encodeURIComponent(query.trim())}`));
      const data: unknown = await res.json();
      if (Array.isArray(data)) {
        setResults(
          data
            .filter((d): d is SearchResult => d?.mediaType === "movie" || d?.mediaType === "tv")
            .slice(0, 8)
            .map((d) => ({ id: d.id, mediaType: d.mediaType, title: d.title, releaseYear: d.releaseYear })),
        );
      } else {
        setResults([]);
      }
    } catch {
      setError("Search failed — try again");
    } finally {
      setSearching(false);
    }
  }

  async function add(r: SearchResult) {
    const mediaType = r.mediaType === "movie" ? "MOVIE" : "TV";
    const k = rowKey(r.id, mediaType);
    if (blocked.has(k)) return;
    setBusy(k);
    setError("");
    try {
      const res = await fetch(withBasePath("/api/admin/blacklist"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tmdbId: r.id, mediaType, title: r.title }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setError(d.error ?? "Failed to block");
        return;
      }
      setItems((prev) => [
        { tmdbId: r.id, mediaType, title: r.title, reason: null, createdAt: new Date().toISOString() },
        ...prev,
      ]);
    } catch {
      setError("Network error — please try again");
    } finally {
      setBusy(null);
    }
  }

  async function remove(row: BlacklistRow) {
    const k = rowKey(row.tmdbId, row.mediaType);
    setBusy(k);
    setError("");
    try {
      const res = await fetch(
        withBasePath(`/api/admin/blacklist?tmdbId=${row.tmdbId}&mediaType=${row.mediaType}`),
        { method: "DELETE" },
      );
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setError(d.error ?? "Failed to remove");
        return;
      }
      setItems((prev) => prev.filter((i) => !(i.tmdbId === row.tmdbId && i.mediaType === row.mediaType)));
    } catch {
      setError("Network error — please try again");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-6" style={{ maxWidth: 720 }}>
      {/* Add a title */}
      <div
        className="flex flex-col gap-3"
        style={{ padding: 16, borderRadius: 10, border: "1px solid var(--ds-border)", background: "var(--ds-bg-1)" }}
      >
        <h2 style={{ fontSize: 14, fontWeight: 600, color: "var(--ds-fg)", margin: 0 }}>Block a title</h2>
        <form onSubmit={runSearch} className="flex items-center gap-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value.slice(0, 200))}
            placeholder="Search TMDB for a movie or show…"
            aria-label="Search for a title to block"
            className="flex-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            style={{
              padding: "8px 12px",
              fontSize: 13,
              color: "var(--ds-fg)",
              background: "var(--ds-bg-2)",
              border: "1px solid var(--ds-border)",
              borderRadius: 6,
            }}
          />
          <button
            type="submit"
            disabled={searching || !query.trim()}
            className="inline-flex items-center gap-1.5"
            style={{
              padding: "8px 14px",
              height: 34,
              borderRadius: 6,
              fontSize: 13,
              fontWeight: 500,
              background: "var(--ds-accent)",
              color: "var(--ds-accent-fg)",
              opacity: searching || !query.trim() ? 0.7 : 1,
            }}
          >
            {searching ? <Loader2 className="animate-spin" style={{ width: 14, height: 14 }} /> : null}
            Search
          </button>
        </form>

        {results.length > 0 && (
          <div className="flex flex-col" style={{ gap: 4 }}>
            {results.map((r) => {
              const mediaType = r.mediaType === "movie" ? "MOVIE" : "TV";
              const k = rowKey(r.id, mediaType);
              const isBlocked = blocked.has(k);
              return (
                <div
                  key={k}
                  className="flex items-center justify-between"
                  style={{ padding: "6px 8px", borderRadius: 6, background: "var(--ds-bg-2)" }}
                >
                  <span style={{ fontSize: 13, color: "var(--ds-fg)" }}>
                    {r.title}
                    {r.releaseYear ? <span style={{ color: "var(--ds-fg-subtle)" }}> ({r.releaseYear})</span> : null}
                    <span style={{ color: "var(--ds-fg-subtle)", marginLeft: 8 }}>{r.mediaType === "movie" ? "Movie" : "TV"}</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => add(r)}
                    disabled={isBlocked || busy === k}
                    className="inline-flex items-center gap-1"
                    style={{
                      padding: "4px 10px",
                      borderRadius: 6,
                      fontSize: 12,
                      fontWeight: 500,
                      color: isBlocked ? "var(--ds-fg-subtle)" : "var(--ds-danger)",
                      border: "1px solid var(--ds-border)",
                      background: "transparent",
                      cursor: isBlocked ? "default" : "pointer",
                    }}
                  >
                    {busy === k ? (
                      <Loader2 className="animate-spin" style={{ width: 12, height: 12 }} />
                    ) : (
                      <Ban style={{ width: 12, height: 12 }} />
                    )}
                    {isBlocked ? "Blocked" : "Block"}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {error && (
        <p className="ds-mono" style={{ fontSize: 12, color: "var(--ds-danger)", margin: 0 }}>
          {error}
        </p>
      )}

      {/* Blocked titles */}
      <div className="flex flex-col gap-2">
        <h2 style={{ fontSize: 14, fontWeight: 600, color: "var(--ds-fg)", margin: 0 }}>
          Blocked titles ({items.length})
        </h2>
        {items.length === 0 ? (
          <p style={{ fontSize: 13, color: "var(--ds-fg-muted)", margin: 0 }}>
            Nothing is blocked. Search above to block a title.
          </p>
        ) : (
          <div className="flex flex-col" style={{ gap: 4 }}>
            {items.map((row) => {
              const k = rowKey(row.tmdbId, row.mediaType);
              return (
                <div
                  key={k}
                  className="flex items-center justify-between"
                  style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid var(--ds-border)", background: "var(--ds-bg-1)" }}
                >
                  <span style={{ fontSize: 13, color: "var(--ds-fg)" }}>
                    {row.title ?? `TMDB #${row.tmdbId}`}
                    <span style={{ color: "var(--ds-fg-subtle)", marginLeft: 8 }}>{row.mediaType === "MOVIE" ? "Movie" : "TV"}</span>
                    {row.reason ? <span style={{ color: "var(--ds-fg-subtle)", marginLeft: 8 }}>· {row.reason}</span> : null}
                  </span>
                  <button
                    type="button"
                    onClick={() => remove(row)}
                    disabled={busy === k}
                    title="Remove from blacklist"
                    aria-label={`Unblock ${row.title ?? row.tmdbId}`}
                    className="inline-flex items-center gap-1"
                    style={{
                      padding: "4px 10px",
                      borderRadius: 6,
                      fontSize: 12,
                      color: "var(--ds-fg-muted)",
                      border: "1px solid var(--ds-border)",
                      background: "transparent",
                    }}
                  >
                    {busy === k ? (
                      <Loader2 className="animate-spin" style={{ width: 12, height: 12 }} />
                    ) : (
                      <X style={{ width: 12, height: 12 }} />
                    )}
                    Unblock
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
