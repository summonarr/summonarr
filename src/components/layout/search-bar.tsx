"use client";

import { useState, useEffect, useRef, useId, useCallback, type RefObject } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { Search, Film, Tv2, Loader2, ChevronRight } from "@/components/icons";
import { useT } from "@/components/i18n/i18n-provider";
import { posterUrl } from "@/lib/tmdb-types";
import { withBasePath } from "@/lib/base-path";
import { fetchJson } from "@/lib/client/fetch-json";
import { searchHits, type SearchHit } from "./search-results";

type MediaFilter = "all" | "movie" | "tv";

const SEARCH_DEBOUNCE_MS = 350;

// The shortcut hint reads "⌘K" on the server and on the first client render;
// the platform is only known after mount (guardrail 16 — no navigator read in
// the render path). Non-Mac users see it flip to "Ctrl K" post-hydration.
function useIsMac(): boolean {
  const [isMac, setIsMac] = useState(true);
  useEffect(() => {
    const platform =
      (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData
        ?.platform ??
      navigator.platform ??
      "";
    setIsMac(/mac|iphone|ipad|ipod/i.test(platform));
  }, []);
  return isMac;
}

// A click outside the search closes its dropdown; ⌘K/Ctrl+K focuses it, and
// Escape closes and leaves it.
function useSearchDismissal(containerRef: RefObject<HTMLDivElement | null>, inputRef: RefObject<HTMLInputElement | null>, setOpen: (open: boolean) => void) {
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [containerRef, setOpen]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // The desktop header's instance stays mounted below lg inside a
      // display:none bar. A hidden input has no offsetParent: leave the key
      // alone there, so it neither swallows the browser's own Ctrl+K nor takes
      // focus from the instance that is actually on screen.
      if (!inputRef.current || inputRef.current.offsetParent === null) return;
      if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      }
      if (e.key === "Escape") {
        setOpen(false);
        inputRef.current?.blur();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [inputRef, setOpen]);
}

// The debounced search: pending from the moment the query changes, one
// request at a time (a newer query aborts the older), and only the newest may
// clear the spinner. `onSettled` runs when an answer (or a failure) lands.
function useSearchResults(query: string, filter: MediaFilter, onSettled: () => void, onCleared: () => void) {
  const [results, setResults] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  // True when the last search failed (non-OK response or network error), so
  // the dropdown says so instead of claiming the title doesn't exist.
  const [searchFailed, setSearchFailed] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    abortRef.current?.abort();
    // Detach the aborted request so it can't clear the pending state this
    // query sets below.
    abortRef.current = null;
    if (!query.trim()) {
      setResults([]);
      setSearchFailed(false);
      setLoading(false);
      onCleared();
      return;
    }

    // Pending from the moment the query changes, not from when the debounced
    // fetch starts — otherwise the debounce window renders "No matches" (or the
    // previous query's "Search is unavailable") for a search that hasn't run.
    setLoading(true);
    setSearchFailed(false);

    debounceRef.current = setTimeout(async () => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setLoading(true);
      const url = withBasePath(`/api/search?q=${encodeURIComponent(query)}${filter !== "all" ? `&type=${filter}` : ""}`);
      const res = await fetchJson(url, { signal: controller.signal });
      if (!res.ok && res.kind === "aborted") return;
      // /api/search answers { error } on a 4xx/5xx: only a list is results.
      const hits = res.ok ? searchHits(res.data) : null;
      setResults(hits ?? []);
      setSearchFailed(hits === null);
      onSettled();
      // Only the newest request may clear the spinner. An aborted older
      // request finishes after its replacement has started, and would
      // otherwise hide the spinner while the new search is still loading.
      if (abortRef.current === controller) setLoading(false);
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      abortRef.current?.abort();
    };
  }, [query, filter, onSettled, onCleared]);

  return { results, loading, searchFailed };
}

function FilterChips({ filter, onFilter, full }: { filter: MediaFilter; onFilter: (f: MediaFilter) => void; full: boolean }) {
  const t = useT();
  const filterLabels: { value: MediaFilter; label: string }[] = [
    { value: "all", label: t("search.filter.all") },
    { value: "movie", label: t("search.filter.movies") },
    { value: "tv", label: t("search.filter.tv") },
  ];
  return (
    <div className="flex gap-1 px-3 pt-2 pb-1.5" style={{ borderBottom: "1px solid var(--ds-border)" }}>
      {filterLabels.map(({ value, label }) => {
        const isActive = filter === value;
        return (
          <button
            key={value}
            type="button"
            // preventDefault on mousedown keeps focus in the search input so
            // the results stay open. The filter itself changes in onClick,
            // which keyboard users (Enter/Space) can trigger too.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onFilter(value)}
            aria-pressed={isActive}
            className="inline-flex items-center gap-1 font-medium transition-colors"
            style={{
              // The full variant is the mobile search sheet: give the chips a
              // touch-sized target there.
              padding: full ? "0 14px" : "2px 10px",
              minHeight: full ? 32 : undefined,
              borderRadius: full ? 6 : 4,
              fontSize: full ? 13 : 11,
              background: isActive ? "var(--ds-accent-soft)" : "transparent",
              color: isActive ? "var(--ds-accent-text)" : "var(--ds-fg-muted)",
            }}
          >
            {value === "movie" && <Film style={{ width: 12, height: 12 }} />}
            {value === "tv" && <Tv2 style={{ width: 12, height: 12 }} />}
            {label}
          </button>
        );
      })}
    </div>
  );
}

function ResultOption({
  media,
  id,
  active,
  showPlex,
  showJellyfin,
  onSelect,
  onHover,
}: {
  media: SearchHit;
  id: string;
  active: boolean;
  showPlex: boolean;
  showJellyfin: boolean;
  onSelect: () => void;
  onHover: () => void;
}) {
  const t = useT();
  const poster = posterUrl(media.posterPath ?? null, "w342");
  return (
    <button
      id={id}
      type="button"
      role="option"
      aria-selected={active}
      // Combobox pattern: focus stays on the input (the active option is
      // announced via aria-activedescendant), so the options are out of the
      // tab order and a click doesn't blur the input.
      tabIndex={-1}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onSelect}
      className="flex items-center gap-2.5 w-full text-left transition-colors"
      style={{
        padding: "8px 12px",
        color: "var(--ds-fg)",
        background: active ? "var(--ds-bg-3)" : "transparent",
      }}
      // The pointer highlights what it MOVES over. Nothing clears the
      // highlight when it leaves: a pointer resting over the list while the
      // keyboard arrows through it must not wipe the option Enter would open.
      onMouseMove={onHover}
    >
      <div
        className="relative shrink-0 overflow-hidden"
        style={{
          width: 28,
          height: 40,
          borderRadius: 3,
          background: "var(--ds-bg-3)",
        }}
      >
        {poster ? (
          <Image
            src={poster}
            alt={media.title}
            fill
            className="object-cover"
            sizes="28px"
          />
        ) : (
          <div
            className="absolute inset-0 flex items-center justify-center"
            style={{ color: "var(--ds-fg-subtle)" }}
          >
            {media.mediaType === "movie" ? (
              <Film style={{ width: 14, height: 14 }} />
            ) : (
              <Tv2 style={{ width: 14, height: 14 }} />
            )}
          </div>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <p
          className="font-medium truncate"
          style={{ fontSize: 13, color: "var(--ds-fg)" }}
        >
          {media.title}
        </p>
        <p
          className="ds-mono truncate"
          style={{ fontSize: 10, color: "var(--ds-fg-subtle)" }}
        >
          {media.releaseYear && `${media.releaseYear} · `}
          {t(media.mediaType === "movie" ? "media.type.movie" : "media.type.tv")}
          {showPlex && media.plexAvailable && (
            <span style={{ color: "var(--ds-plex-text)", marginLeft: 6 }}>
              · plex
            </span>
          )}
          {showJellyfin && media.jellyfinAvailable && (
            <span
              style={{ color: "var(--ds-jellyfin-text)", marginLeft: 6 }}
            >
              · jellyfin
            </span>
          )}
        </p>
      </div>
      <ChevronRight
        style={{
          width: 14,
          height: 14,
          color: "var(--ds-fg-subtle)",
        }}
      />
    </button>
  );
}

// Debounced media search combobox (⌘K); queries /api/search and routes to the
// selected title's detail page.
export function SearchBar({
  showPlex,
  showJellyfin,
  variant = "inline",
  autoFocus,
  onAfterSelect,
}: {
  showPlex: boolean;
  showJellyfin: boolean;
  variant?: "inline" | "full";
  autoFocus?: boolean;
  onAfterSelect?: () => void;
}) {
  const t = useT();
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<MediaFilter>("all");
  const [open, setOpen] = useState(false);
  // Keyboard-highlighted option (-1 = none). Mouse hover shares the same
  // state so the highlight visual has a single source of truth.
  const [activeIndex, setActiveIndex] = useState(-1);
  // Unique id prefix per SearchBar. It is mounted twice (desktop header and
  // mobile sheet), so fixed ids would appear twice in the page and confuse
  // screen readers (aria-activedescendant / aria-controls point at them).
  const optionIdBase = useId();
  const listboxId = `${optionIdBase}-listbox`;
  const isMac = useIsMac();
  useSearchDismissal(containerRef, inputRef, setOpen);

  useEffect(() => {
    if (!autoFocus) return;
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [autoFocus]);

  // Results that land after the user clicked away (or pressed Escape) must not
  // pop the list back open over the page: open only while focus is still in
  // the search. The results themselves are kept for when it is refocused.
  const onSettled = useCallback(() => {
    setActiveIndex(-1);
    if (containerRef.current?.contains(document.activeElement)) setOpen(true);
  }, []);
  const onCleared = useCallback(() => {
    setActiveIndex(-1);
    setOpen(false);
  }, []);
  const { results, loading, searchFailed } = useSearchResults(query, filter, onSettled, onCleared);

  function handleSelect(media: SearchHit) {
    setOpen(false);
    setQuery("");
    setActiveIndex(-1);
    onAfterSelect?.();
    router.push(`/${media.mediaType}/${media.id}`);
  }

  // Minimal combobox keyboard support: ArrowDown/ArrowUp move the highlight
  // (wrapping), Enter activates it. Escape is handled by the window-level
  // listener above.
  function handleInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (results.length === 0) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      setActiveIndex((i) =>
        e.key === "ArrowDown"
          ? (i + 1) % results.length
          : i <= 0
            ? results.length - 1
            : i - 1,
      );
    } else if (e.key === "Enter" && open && activeIndex >= 0 && activeIndex < results.length) {
      e.preventDefault();
      handleSelect(results[activeIndex]);
    }
  }

  const fieldHeight = variant === "full" ? 36 : 32;
  const showStatus = Boolean(query.trim()) && results.length === 0 && !loading;

  return (
    <div
      ref={containerRef}
      className={variant === "full" ? "relative flex-1 min-w-0" : "relative flex-1 min-w-0 max-w-[520px]"}
    >
      <div
        className="flex items-center"
        style={{
          background: "var(--ds-bg-1)",
          border: "1px solid var(--ds-border)",
          borderRadius: 6,
          height: fieldHeight,
          padding: "0 8px 0 10px",
          transition:
            "border-color 120ms var(--ds-ease), background 120ms var(--ds-ease)",
        }}
      >
        <Search
          className="shrink-0"
          style={{
            width: 14,
            height: 14,
            color: "var(--ds-fg-subtle)",
            marginRight: 8,
          }}
        />
        <input
          ref={inputRef}
          type="search"
          aria-label={t("nav.search")}
          role="combobox"
          aria-expanded={open && (Boolean(query.trim()) || results.length > 0)}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={
            open && activeIndex >= 0 && activeIndex < results.length
              ? `${optionIdBase}-option-${activeIndex}`
              : undefined
          }
          placeholder={t("search.placeholder")}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleInputKeyDown}
          // The full variant is the mobile search sheet: 16px below md, or iOS
          // Safari zooms the page on focus. The compact one shows only at lg+.
          className={`flex-1 min-w-0 bg-transparent border-0 outline-none rounded-sm focus-visible:ring-2 focus-visible:ring-ring ${variant === "full" ? "text-base md:text-sm" : "text-[13px]"}`}
          style={{ color: "var(--ds-fg)" }}
        />
        {loading ? (
          <Loader2
            style={{
              width: 14,
              height: 14,
              color: "var(--ds-fg-subtle)",
            }}
            className="animate-spin"
          />
        ) : variant === "inline" ? (
          <kbd className="ds-kbd">{isMac ? "⌘K" : "Ctrl K"}</kbd>
        ) : null}
      </div>

      {open && (query.trim() || results.length > 0) && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            left: 0,
            right: 0,
            zIndex: 50,
            background: "var(--ds-bg-2)",
            border: "1px solid var(--ds-border)",
            borderRadius: 8,
            boxShadow: "var(--ds-shadow-lg)",
            overflow: "hidden",
          }}
        >
          {/* The filter chips and the status line sit OUTSIDE the listbox: a
              listbox may only hold options, and anything else in it skewed the
              option count a screen reader announces. */}
          <FilterChips filter={filter} onFilter={setFilter} full={variant === "full"} />
          {/* The results body scrolls on its own: the listbox lives in the
              sticky top bar (not the scrolling <main>) and the outer container
              clips overflow for its rounded corners, so on a short viewport
              (landscape phone, keyboard up) rows past the fold were
              unreachable. */}
          <div style={{ maxHeight: "min(70vh, 480px)", overflowY: "auto" }}>
            {showStatus && (
              <div
                role="status"
                className="text-center"
                style={{
                  padding: "14px 12px",
                  fontSize: 13,
                  color: "var(--ds-fg-subtle)",
                }}
              >
                {searchFailed ? t("search.unavailable") : t("search.noMatches")}
              </div>
            )}
            <div id={listboxId} role="listbox" aria-label={t("search.results")}>
              {results.map((media, i) => (
                <ResultOption
                  key={`${media.mediaType}-${media.id}`}
                  media={media}
                  id={`${optionIdBase}-option-${i}`}
                  active={activeIndex === i}
                  showPlex={showPlex}
                  showJellyfin={showJellyfin}
                  onSelect={() => handleSelect(media)}
                  onHover={() => { if (activeIndex !== i) setActiveIndex(i); }}
                />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
