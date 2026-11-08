"use client";

import { useMemo, useState } from "react";
import { withBasePath } from "@/lib/base-path";
import { fetchJson, jsonInit } from "@/lib/client/fetch-json";
import { useAsyncAction } from "@/hooks/use-async-action";
import { Ban, X, Loader2 } from "@/components/icons";
import { useT } from "@/components/i18n/i18n-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LocalDateText } from "@/components/local-date";
import {
  addAnswerFrom, filterRows, removedCountFrom, rowKey, rowMediaType, searchResultsFrom,
  type BlacklistKey, type BlacklistRow, type SearchResult,
} from "@/components/admin/blacklist-rows";

// The manager's state and its three requests. Every row has its own in-flight
// slot (its key): one request finishing never re-enables another row's button
// mid-request, and a second click on a busy row is skipped, never sent twice.
function useBlacklist(initial: BlacklistRow[], total: number) {
  const t = useT();
  const actions = useAsyncAction();
  const [items, setItems] = useState<BlacklistRow[]>(initial);
  // Real blocked count (may exceed the page's slice). Adjusted locally on add/remove.
  const [blockedTotal, setBlockedTotal] = useState(total);
  const [query, setQuery] = useState("");
  const [reason, setReason] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  // True once a search has come back successfully, so an empty result list can
  // say "no matches" instead of rendering nothing at all.
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState("");
  // Client-side narrowing of the blocked list (the page ships up to 1,000 rows).
  const [filter, setFilter] = useState("");

  const blocked = new Set(items.map((i) => rowKey(i.tmdbId, i.mediaType)));
  // Blocked per the loaded rows OR the search's own flag, which covers titles past
  // the 1000 the page ships (a stale "Block" there rewrote the stored reason).
  const isBlocked = (r: SearchResult, k: string) => blocked.has(k) || r.blacklisted;
  const visible = useMemo(() => filterRows(items, filter), [items, filter]);
  // A failure the admin should read: the route's own reason, else a network one.
  const failureText = (res: { kind: string; error: string }) => (res.kind === "http" ? res.error : t("shared.thread.networkError"));

  async function runSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim()) {
      actions.abort("search");
      setResults([]);
      setSearched(false);
      return;
    }
    setSearched(false);
    setError("");
    // A newer search supersedes one still out.
    const res = await actions.run("search", (signal) =>
      fetchJson(withBasePath(`/api/search?q=${encodeURIComponent(query.trim())}`), { signal, fallbackError: t("adminQueue.blacklist.searchFailed") }));
    if (!res) return;
    // /api/search answers `{ error }` on 429 (rate limit), 400 and 500. Without
    // this the error body falls through to an empty list, which reads as "TMDB
    // has no such title".
    if (!res.ok) {
      setError(res.kind === "http" ? res.error : t("adminQueue.blacklist.searchFailed"));
      return;
    }
    setSearched(true);
    setResults(searchResultsFrom(res.data));
  }

  async function add(r: SearchResult) {
    const mediaType = rowMediaType(r);
    const k = rowKey(r.id, mediaType);
    if (isBlocked(r, k)) return;
    const trimmedReason = reason.trim();
    setError("");
    const res = await actions.run(k, (signal) =>
      fetchJson(withBasePath("/api/admin/blacklist"), {
        init: jsonInit("POST", {
          tmdbId: r.id,
          mediaType,
          title: r.title,
          ...(trimmedReason ? { reason: trimmedReason } : {}),
        }),
        signal,
        fallbackError: t("adminQueue.blacklist.blockFailed"),
      }), { ifBusy: "skip" });
    if (!res) return;
    // A 2xx whose body won't parse still blocked the title: kept with local values.
    if (!res.ok && res.kind !== "invalid") {
      setError(failureText(res));
      return;
    }
    // The route is an "upsert" (insert, or update if it already exists) and
    // answers 201 either way, with `created` saying which. Another admin (or
    // another tab) can block the same title meanwhile, so remove any existing
    // row for it before adding: the list never holds two rows with the same
    // React key. Prefer the server's row (cleaned title/reason, real
    // createdAt); fall back to local values if the body won't parse.
    const d = addAnswerFrom(res.ok ? res.data : null);
    const item = d.item;
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
    // The count goes up only when the server says it added a row: the loaded
    // list holds at most 1000 rows and this call's `items` closure can be stale,
    // so neither can tell a new title from a rewritten one. An unreadable body
    // leaves the count as it is until the next load.
    if (d.created) setBlockedTotal((n) => n + 1);
    // The placeholder promises the reason is "saved with the NEXT title you
    // block" — one-shot — so it must not silently ride along onto a second,
    // unrelated title from the same result list.
    setReason("");
  }

  // Unblocks a loaded row, or a search hit: a title past the 1000 rows the page
  // ships can only be reached through the search.
  async function remove(row: BlacklistKey) {
    const k = rowKey(row.tmdbId, row.mediaType);
    setError("");
    const res = await actions.run(k, (signal) =>
      fetchJson(withBasePath(`/api/admin/blacklist?tmdbId=${row.tmdbId}&mediaType=${row.mediaType}`), {
        init: { method: "DELETE" },
        signal,
        fallbackError: t("adminQueue.blacklist.removeFailed"),
      }), { ifBusy: "skip" });
    if (!res) return;
    if (!res.ok && res.kind !== "invalid") {
      setError(failureText(res));
      return;
    }
    setItems((prev) => prev.filter((i) => !(i.tmdbId === row.tmdbId && i.mediaType === row.mediaType)));
    // Down only by what the server removed: 0 when another admin already did.
    const removed = removedCountFrom(res.ok ? res.data : null);
    if (removed > 0) setBlockedTotal((n) => Math.max(0, n - removed));
    // The search's flag predates this unblock: clear it, or the title would
    // still read as blocked in the results above.
    setResults((prev) =>
      prev.map((r) =>
        r.id === row.tmdbId && rowMediaType(r) === row.mediaType ? { ...r, blacklisted: false } : r,
      ),
    );
  }

  return {
    items, visible, blockedTotal, query, setQuery, reason, setReason, results, searched, error, filter, setFilter,
    searching: actions.busy("search"), busy: (k: string) => actions.busy(k), isBlocked, runSearch, add, remove,
  };
}

type Blacklist = ReturnType<typeof useBlacklist>;

export function BlacklistManager({ initial, total }: { initial: BlacklistRow[]; total: number }) {
  const bl = useBlacklist(initial, total);
  return (
    <div className="flex flex-col gap-6" style={{ maxWidth: 720 }}>
      <BlockSearchPanel bl={bl} />

      {bl.error && (
        <p role="alert" className="ds-mono" style={{ fontSize: 12, color: "var(--ds-danger)", margin: 0 }}>
          {bl.error}
        </p>
      )}

      <BlockedList bl={bl} />
    </div>
  );
}

// Add a title: a TMDB search, the one-shot reason, and the results.
function BlockSearchPanel({ bl }: { bl: Blacklist }) {
  const t = useT();
  const { query, setQuery, reason, setReason, searching, searched, results } = bl;
  return (
    <div
      className="flex flex-col gap-3"
      style={{ padding: 16, borderRadius: 10, border: "1px solid var(--ds-border)", background: "var(--ds-bg-1)" }}
    >
      <h2 style={{ fontSize: 14, fontWeight: 600, color: "var(--ds-fg)", margin: 0 }}>{t("adminQueue.blacklist.blockHeading")}</h2>
      <form onSubmit={bl.runSearch} className="flex items-center gap-2">
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
          {results.map((r) => <SearchResultRow key={rowKey(r.id, rowMediaType(r))} r={r} bl={bl} />)}
        </div>
      )}
    </div>
  );
}

// A search hit: Block it, or — already blocked — say so and offer Unblock.
function SearchResultRow({ r, bl }: { r: SearchResult; bl: Blacklist }) {
  const t = useT();
  const mediaType = rowMediaType(r);
  const k = rowKey(r.id, mediaType);
  const rowBlocked = bl.isBlocked(r, k);
  const rowBusy = bl.busy(k);
  return (
    <div
      className="flex items-center justify-between"
      style={{ padding: "6px 8px", borderRadius: 6, background: "var(--ds-bg-2)" }}
    >
      <span style={{ fontSize: 13, color: "var(--ds-fg)" }}>
        {r.title}
        {r.releaseYear ? <span style={{ color: "var(--ds-fg-subtle)" }}> ({r.releaseYear})</span> : null}
        <span style={{ color: "var(--ds-fg-subtle)", marginLeft: 8 }}>{r.mediaType === "movie" ? t("adminQueue.blacklist.movie") : t("adminQueue.blacklist.tv")}</span>
      </span>
      {rowBlocked ? (
        <span className="flex shrink-0 items-center gap-2">
          <span style={{ fontSize: 12, color: "var(--ds-fg-subtle)" }}>{t("adminQueue.blacklist.blocked")}</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void bl.remove({ tmdbId: r.id, mediaType })}
            disabled={rowBusy}
            title={t("adminQueue.blacklist.removeTitle")}
            aria-label={t("adminQueue.blacklist.unblockAria", { title: r.title })}
          >
            {rowBusy ? <Loader2 className="animate-spin" /> : <X />}
            {t("adminQueue.blacklist.unblock")}
          </Button>
        </span>
      ) : (
        <Button
          variant="destructive"
          size="sm"
          onClick={() => void bl.add(r)}
          disabled={rowBusy}
          className="shrink-0"
        >
          {rowBusy ? <Loader2 className="animate-spin" /> : <Ban />}
          {t("adminQueue.blacklist.block")}
        </Button>
      )}
    </div>
  );
}

// The blocked titles loaded with the page, narrowed by the client filter.
function BlockedList({ bl }: { bl: Blacklist }) {
  const t = useT();
  const { items, visible, blockedTotal, filter, setFilter } = bl;
  return (
    <div className="flex flex-col gap-2">
      <h2 style={{ fontSize: 14, fontWeight: 600, color: "var(--ds-fg)", margin: 0 }}>
        {t("adminQueue.blacklist.blockedHeading", { count: blockedTotal })}
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
                      onClick={() => void bl.remove(row)}
                      disabled={bl.busy(k)}
                      title={t("adminQueue.blacklist.removeTitle")}
                      aria-label={t("adminQueue.blacklist.unblockAria", { title: row.title ?? row.tmdbId })}
                      className="shrink-0"
                    >
                      {bl.busy(k) ? <Loader2 className="animate-spin" /> : <X />}
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
  );
}
