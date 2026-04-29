"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { Search, Film, Tv2, Loader2, ChevronRight } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { signOut, useSession } from "next-auth/react";
import { PushNotifications } from "@/components/layout/push-notifications";
import { breadcrumbFor } from "@/components/layout/breadcrumb-label";
import Image from "next/image";
import { posterUrl, type TmdbMedia } from "@/lib/tmdb-types";
import { useHasMounted } from "@/hooks/use-has-mounted";

type MediaFilter = "all" | "movie" | "tv";

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
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<MediaFilter>("all");
  const [results, setResults] = useState<TmdbMedia[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  useEffect(() => {
    if (!autoFocus) return;
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [autoFocus]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
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
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    abortRef.current?.abort();
    if (!query.trim()) {
      setResults([]);
      setOpen(false);
      return;
    }

    debounceRef.current = setTimeout(async () => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setLoading(true);
      try {
        const url = `/api/search?q=${encodeURIComponent(query)}${filter !== "all" ? `&type=${filter}` : ""}`;
        const res = await fetch(url, { signal: controller.signal });
        const data: TmdbMedia[] = await res.json();
        setResults(data.slice(0, 8));
        setOpen(true);
      } catch (err) {
        if ((err as Error).name !== "AbortError") setResults([]);
      } finally {
        setLoading(false);
      }
    }, 350);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      abortRef.current?.abort();
    };
  }, [query, filter]);

  function handleSelect(media: TmdbMedia) {
    setOpen(false);
    setQuery("");
    onAfterSelect?.();
    router.push(`/${media.mediaType}/${media.id}`);
  }

  const filterLabels: { value: MediaFilter; label: string }[] = [
    { value: "all", label: "All" },
    { value: "movie", label: "Movies" },
    { value: "tv", label: "TV" },
  ];

  const fieldHeight = variant === "full" ? 36 : 32;

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
          placeholder="Search movies, TV, requests…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          className="flex-1 min-w-0 bg-transparent border-0 outline-none"
          style={{
            fontSize: variant === "full" ? 14 : 13,
            color: "var(--ds-fg)",
          }}
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
          <kbd className="ds-kbd">⌘K</kbd>
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
          <div
            className="flex gap-1 px-3 pt-2 pb-1.5"
            style={{ borderBottom: "1px solid var(--ds-border)" }}
          >
            {filterLabels.map(({ value, label }) => {
              const isActive = filter === value;
              return (
                <button
                  key={value}
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setFilter(value);
                  }}
                  className="inline-flex items-center gap-1 font-medium transition-colors"
                  style={{
                    padding: "2px 10px",
                    borderRadius: 4,
                    fontSize: 11,
                    background: isActive ? "var(--ds-accent-soft)" : "transparent",
                    color: isActive ? "var(--ds-accent)" : "var(--ds-fg-muted)",
                  }}
                >
                  {value === "movie" && <Film style={{ width: 12, height: 12 }} />}
                  {value === "tv" && <Tv2 style={{ width: 12, height: 12 }} />}
                  {label}
                </button>
              );
            })}
          </div>
          {query.trim() && results.length === 0 && !loading ? (
            <div
              className="text-center"
              style={{
                padding: "14px 12px",
                fontSize: 13,
                color: "var(--ds-fg-subtle)",
              }}
            >
              No matches
            </div>
          ) : (
            results.map((media) => {
              const poster = posterUrl(media.posterPath, "w342");
              return (
                <button
                  key={`${media.mediaType}-${media.id}`}
                  onClick={() => handleSelect(media)}
                  className="flex items-center gap-2.5 w-full text-left transition-colors"
                  style={{
                    padding: "8px 12px",
                    color: "var(--ds-fg)",
                    background: "transparent",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "var(--ds-bg-3)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "transparent";
                  }}
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
                      {media.mediaType === "movie" ? "MOVIE" : "TV"}
                      {showPlex && media.plexAvailable && (
                        <span style={{ color: "var(--ds-plex)", marginLeft: 6 }}>
                          · plex
                        </span>
                      )}
                      {showJellyfin && media.jellyfinAvailable && (
                        <span
                          style={{ color: "var(--ds-jellyfin)", marginLeft: 6 }}
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
            })
          )}
        </div>
      )}
    </div>
  );
}

export function Header() {
  const pathname = usePathname();
  const router = useRouter();
  const { data: session } = useSession();
  const mounted = useHasMounted();
  const role = session?.user?.role;
  const provider = session?.user?.provider;
  const showPlex =
    role === "ADMIN" || role === "ISSUE_ADMIN" || provider === "plex";
  const showJellyfin =
    role === "ADMIN" ||
    role === "ISSUE_ADMIN" ||
    provider === "jellyfin" ||
    provider === "jellyfin-quickconnect";
  const initials = session?.user?.name
    ?.split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase();

  const crumbs = breadcrumbFor(pathname);

  return (
    <header
      className="hidden lg:flex items-center sticky top-0 z-30"
      style={{
        gap: 14,
        padding: "10px 18px",
        height: 52,
        borderBottom: "1px solid var(--ds-border)",
        background: "color-mix(in oklab, var(--ds-bg) 85%, transparent)",
        backdropFilter: "blur(10px)",
      }}
    >
      {/* Breadcrumb */}
      <div className="flex items-center min-w-0" style={{ gap: 6 }}>
        {crumbs.map((c, i) => {
          const last = i === crumbs.length - 1;
          const content = (
            <span
              className="font-medium"
              style={{
                fontSize: 13,
                fontWeight: last ? 500 : 400,
                color: last ? "var(--ds-fg)" : "var(--ds-fg-muted)",
              }}
            >
              {c.label}
            </span>
          );
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: crumbs are positional
            <span key={i} className="flex items-center" style={{ gap: 6 }}>
              {i > 0 && (
                <ChevronRight
                  style={{
                    width: 12,
                    height: 12,
                    color: "var(--ds-fg-subtle)",
                  }}
                />
              )}
              {c.href && !last ? (
                <Link
                  href={c.href}
                  className="hover:text-[var(--ds-fg)] transition-colors"
                >
                  {content}
                </Link>
              ) : (
                content
              )}
            </span>
          );
        })}
      </div>

      {/* Search */}
      <div className="flex-1 min-w-0 flex justify-center">
        <SearchBar showPlex={showPlex} showJellyfin={showJellyfin} />
      </div>

      {/* Actions
       *
       * Gated on `useHasMounted` to avoid React #418 hydration mismatches.
       * `<DropdownMenu>` (base-ui) and `<PushNotifications>` both have
       * client-only state machines whose first-render output can differ
       * subtly between SSR and CSR (image-load probes, permission lookups,
       * etc.). Rendering them only after mount produces a deterministic SSR
       * tree at the cost of a 1-frame avatar pop-in — a trade we accept,
       * see CLAUDE.md guardrail-1 (Next.js 16 + React 19 hydration is strict).
       */}
      <div
        className="flex items-center gap-1.5"
        style={{ minWidth: 28, minHeight: 28 }}
      >
        {mounted && session && <PushNotifications />}

        {mounted && (
        <DropdownMenu>
          <DropdownMenuTrigger className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-accent-ring)]">
            <Avatar
              className="cursor-pointer"
              style={{
                width: 28,
                height: 28,
                border: "1px solid var(--ds-border)",
              }}
            >
              {/*
                Only render <AvatarImage> when we have a real src. Passing src=""
                triggers a Radix/base-ui hydration mismatch (React #418) — server
                renders the <img> in idle state, but on the client an empty src
                fires `onerror` immediately, switching to the fallback before
                hydration completes.
              */}
              {session?.user?.image ? (
                <AvatarImage src={session.user.image} />
              ) : null}
              <AvatarFallback
                className="font-semibold"
                style={{
                  fontSize: 11,
                  background: "var(--ds-bg-3)",
                  color: "var(--ds-fg)",
                }}
              >
                {initials ?? "?"}
              </AvatarFallback>
            </Avatar>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <div
              style={{
                padding: "6px 8px",
                fontSize: 13,
                fontWeight: 500,
                color: "var(--ds-fg)",
              }}
            >
              {session?.user?.name ?? session?.user?.email}
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => router.push("/profile")}>
              Profile
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => router.push("/settings")}>
              Settings
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-red-400"
              onClick={() => signOut({ callbackUrl: "/login" })}
            >
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        )}
      </div>
    </header>
  );
}
