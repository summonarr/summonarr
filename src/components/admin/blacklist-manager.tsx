"use client";

import { useMemo, useState } from "react";
import { withBasePath } from "@/lib/base-path";
import { Ban, X, Loader2 } from "@/components/icons";
import { useT } from "@/components/i18n/i18n-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LocalDateText } from "@/components/local-date";

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
  const t = useT();
  const [items, setItems] = useState<BlacklistRow[]>(initial);
  const [query, setQuery] = useState("");
  const [reason, setReason] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  // True once a search has come back successfully, so an empty result list can
  // say "no matches" instead of rendering nothing at all.
  const [searched, setSearched] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  // Client-side narrowing of the blocked list (the page ships up to 1,000 rows).
  const [filter, setFilter] = useState("");

  const blocked = new Set(items.map((i) => rowKey(i.tmdbId, i.mediaType)));
  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return items;
    return items.filter(
      (i) =>
        (i.title ?? `TMDB #${i.tmdbId}`).toLowerCase().includes(needle) ||
        (i.reason ?? "").toLowerCase().includes(needle) ||
        String(i.tmdbId) === needle,
    );
  }, [items, filter]);

  async function runSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim()) {
      setResults([]);
      setSearched(false);
      return;
    }
    setSearching(true);
    setSearched(false);
    setError("");
    try {
      const res = await fetch(withBasePath(`/api/search?q=${encodeURIComponent(query.trim())}`));
      const data: unknown = await res.json();
      // /api/search answers `{ error }` on 429 (rate limit), 400 and 500. Without
      // this the error body falls through Array.isArray to setResults([]) and the
      // empty list reads as "TMDB has no such title".
      if (!res.ok) {
        setError((data as { error?: string } | null)?.error ?? t("adminQueue.blacklist.searchFailed"));
        return;
      }
      setSearched(true);
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
      setError(t("adminQueue.blacklist.searchFailed"));
    } finally {
      setSearching(false);
    }
  }

  async function add(r: SearchResult) {
    const mediaType = r.mediaType === "movie" ? "MOVIE" : "TV";
    const k = rowKey(r.id, mediaType);
    if (blocked.has(k)) return;
    const trimmedReason = reason.trim();
    setBusy(k);
    setError("");
    try {
      const res = await fetch(withBasePath("/api/admin/blacklist"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tmdbId: r.id,
          mediaType,
          title: r.title,
          ...(trimmedReason ? { reason: trimmedReason } : {}),
        }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setError(d.error ?? t("adminQueue.blacklist.blockFailed"));
        return;
      }
      // The route is an "upsert" (insert, or update if it already exists) and
      // answers 201 either way. Only one button is disabled at a time, so
      // Block A → Block B → Block A can send two POSTs for A. Remove any existing
      // row for this title before adding, so the list never holds two rows with
      // the same React key. Prefer the server's row (cleaned title/reason, real
      // createdAt); fall back to local values if the body won't parse.
      const d = (await res.json().catch(() => ({}))) as { item?: Partial<BlacklistRow> | null };
      const item = d?.item ?? null;
      setItems((prev) => [
        {
          tmdbId: r.id,
          mediaType,
          title: item?.title ?? r.title,
          reason: item?.reason ?? (trimmedReason || null),
          createdAt: item?.createdAt ?? new Date().toISOString(),
        },
        ...prev.filter((i) => !(i.tmdbId === r.id && i.mediaType === mediaType)),
      ]);
      // The placeholder promises the reason is "saved with the NEXT title you
      // block" — one-shot — so it must not silently ride along onto a second,
      // unrelated title from the same result list.
      setReason("");
    } catch {
      setError(t("shared.thread.networkError"));
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
        setError(d.error ?? t("adminQueue.blacklist.removeFailed"));
        return;
      }
      setItems((prev) => prev.filter((i) => !(i.tmdbId === row.tmdbId && i.mediaType === row.mediaType)));
    } catch {
      setError(t("shared.thread.networkError"));
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
        <h2 style={{ fontSize: 14, fontWeight: 600, color: "var(--ds-fg)", margin: 0 }}>{t("adminQueue.blacklist.blockHeading")}</h2>
        <form onSubmit={runSearch} className="flex items-center gap-2">
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value.slice(0, 200))}
            placeholder={t("adminQueue.blacklist.searchPlaceholder")}
            aria-label={t("adminQueue.blacklist.searchAria")}
            className="flex-1"
          />
          {/* Button defaults to type="button"; this one really submits the form. */}
          <Button type="submit" disabled={searching || !query.trim()}>
            {searching ? <Loader2 className="animate-spin" /> : null}
            {t("adminQueue.actions.search")}
          </Button>
        </form>

        <Input
          value={reason}
          onChange={(e) => setReason(e.target.value.slice(0, 500))}
          placeholder={t("adminQueue.blacklist.reasonPlaceholder")}
          aria-label={t("adminQueue.blacklist.reasonAria")}
        />

        {searched && !searching && results.length === 0 && (
          <p role="status" style={{ fontSize: 12, color: "var(--ds-fg-subtle)", margin: 0 }}>
            {t("adminQueue.blacklist.noMatches")}
          </p>
        )}

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
                    <span style={{ color: "var(--ds-fg-subtle)", marginLeft: 8 }}>{r.mediaType === "movie" ? t("adminQueue.blacklist.movie") : t("adminQueue.blacklist.tv")}</span>
                  </span>
                  <Button
                    variant={isBlocked ? "outline" : "destructive"}
                    size="sm"
                    onClick={() => add(r)}
                    disabled={isBlocked || busy === k}
                    className="shrink-0"
                  >
                    {busy === k ? <Loader2 className="animate-spin" /> : <Ban />}
                    {isBlocked ? t("adminQueue.blacklist.blocked") : t("adminQueue.blacklist.block")}
                  </Button>
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
          {t("adminQueue.blacklist.blockedHeading", { count: items.length })}
        </h2>
        {items.length === 0 ? (
          <p style={{ fontSize: 13, color: "var(--ds-fg-muted)", margin: 0 }}>
            {t("adminQueue.blacklist.empty")}
          </p>
        ) : (
          <>
            <Input
              type="search"
              value={filter}
              onChange={(e) => setFilter(e.target.value.slice(0, 200))}
              placeholder={t("adminQueue.blacklist.filterPlaceholder")}
              aria-label={t("adminQueue.blacklist.filterAria")}
            />
            {visible.length === 0 ? (
              <p role="status" style={{ fontSize: 12, color: "var(--ds-fg-subtle)", margin: 0 }}>
                {t("adminQueue.blacklist.filterNoMatch")}
              </p>
            ) : (
              <div className="flex flex-col" style={{ gap: 4 }}>
                {visible.map((row) => {
                  const k = rowKey(row.tmdbId, row.mediaType);
                  return (
                    <div
                      key={k}
                      className="flex items-center justify-between gap-3"
                      style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid var(--ds-border)", background: "var(--ds-bg-1)" }}
                    >
                      <div className="flex flex-col min-w-0" style={{ gap: 2 }}>
                        <span style={{ fontSize: 13, color: "var(--ds-fg)" }}>
                          {row.title ?? `TMDB #${row.tmdbId}`}
                          <span style={{ color: "var(--ds-fg-subtle)", marginLeft: 8 }}>{row.mediaType === "MOVIE" ? t("adminQueue.blacklist.movie") : t("adminQueue.blacklist.tv")}</span>
                        </span>
                        {/* Blocked-on date in the viewer's locale/timezone (hydration-gated
                            inside LocalDateText — guardrail 16) plus the stored reason. */}
                        <span className="ds-mono" style={{ fontSize: 11, color: "var(--ds-fg-subtle)" }}>
                          <LocalDateText iso={row.createdAt} />
                          {row.reason ? ` · ${row.reason}` : null}
                        </span>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => remove(row)}
                        disabled={busy === k}
                        title={t("adminQueue.blacklist.removeTitle")}
                        aria-label={t("adminQueue.blacklist.unblockAria", { title: row.title ?? row.tmdbId })}
                        className="shrink-0"
                      >
                        {busy === k ? <Loader2 className="animate-spin" /> : <X />}
                        {t("adminQueue.blacklist.unblock")}
                      </Button>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
