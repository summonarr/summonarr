"use client";

import { useState, useEffect, useRef, useId } from "react";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { Search, Film, Tv2, Loader2, ChevronRight } from "@/components/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useSummonarrSession } from "@/components/auth/summonarr-session-provider";
import { hasPermission, Permission, parsePermissions } from "@/lib/permissions";
import { PushNotifications } from "@/components/layout/push-notifications";
import { NotificationBell } from "@/components/layout/notification-bell";

async function signOutAndRedirect(callbackUrl: string) {
  try {
    await fetch(withBasePath("/api/auth/sign-out"), { method: "POST", credentials: "include" });
  } catch {
    // ignore — best-effort
  }
  window.location.href = withBasePath(callbackUrl);
}
import { breadcrumbFor } from "@/components/layout/breadcrumb-label";
import { AppearanceMenu } from "@/components/theme/appearance-menu";
import Image from "next/image";
import { posterUrl, type TmdbMedia } from "@/lib/tmdb-types";
import { withBasePath } from "@/lib/base-path";

type MediaFilter = "all" | "movie" | "tv";

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
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<MediaFilter>("all");
  const [results, setResults] = useState<TmdbMedia[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  // Keyboard-highlighted option (-1 = none). Mouse hover shares the same
  // state so the highlight visual has a single source of truth.
  const [activeIndex, setActiveIndex] = useState(-1);
  // Per-instance option-id base — the SearchBar mounts twice (desktop header
  // + mobile sheet), so ids must not collide for aria-activedescendant.
  const optionIdBase = useId();
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
      setActiveIndex(-1);
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
        // /api/search can return { error } on 4xx/5xx — guard before .slice so a
        // non-array body doesn't blow up the debounced handler.
        const data: unknown = res.ok ? await res.json() : null;
        setResults(Array.isArray(data) ? (data as TmdbMedia[]).slice(0, 8) : []);
        setActiveIndex(-1);
        setOpen(true);
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          setResults([]);
          setActiveIndex(-1);
        }
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
          type="search"
          aria-label="Search"
          role="combobox"
          aria-expanded={open && (Boolean(query.trim()) || results.length > 0)}
          aria-controls="header-search-results"
          aria-autocomplete="list"
          aria-activedescendant={
            open && activeIndex >= 0 && activeIndex < results.length
              ? `${optionIdBase}-option-${activeIndex}`
              : undefined
          }
          placeholder="Search movies, TV, requests…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleInputKeyDown}
          className="flex-1 min-w-0 bg-transparent border-0 outline-none rounded-sm focus-visible:ring-2 focus-visible:ring-ring"
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
          id="header-search-results"
          role="listbox"
          aria-label="Search results"
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
            results.map((media, i) => {
              const poster = posterUrl(media.posterPath, "w342");
              return (
                <button
                  key={`${media.mediaType}-${media.id}`}
                  id={`${optionIdBase}-option-${i}`}
                  role="option"
                  aria-selected={activeIndex === i}
                  onClick={() => handleSelect(media)}
                  className="flex items-center gap-2.5 w-full text-left transition-colors"
                  style={{
                    padding: "8px 12px",
                    color: "var(--ds-fg)",
                    background:
                      activeIndex === i ? "var(--ds-bg-3)" : "transparent",
                  }}
                  onMouseEnter={() => setActiveIndex(i)}
                  onMouseLeave={() => setActiveIndex(-1)}
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

// Desktop top bar: breadcrumb, search, push toggle, and the account dropdown.
export function Header() {
  const pathname = usePathname();
  const router = useRouter();
  const { session } = useSummonarrSession();
  const role = session?.user?.role;
  const provider = session?.user?.provider;
  const permsStr = session?.user?.permissions;
  const eff = permsStr ? parsePermissions(permsStr) : 0n;
  const isAdminLike = role === "ADMIN" || hasPermission(eff, Permission.ADMIN) || role === "ISSUE_ADMIN" || hasPermission(eff, Permission.MANAGE_ISSUES);
  const showPlex =
    isAdminLike || provider === "plex";
  const showJellyfin =
    isAdminLike ||
    provider === "jellyfin" ||
    provider === "jellyfin-quickconnect";
  // `image` isn't part of SummonarrSession yet — claims are kept slim. Avatar
  // falls back to initials when image is absent, which is the existing
  // behaviour for credentials/plex/jellyfin users who never had it set anyway.
  const sessionUserImage = (session?.user as { image?: string | null } | undefined)?.image;
  const initials = session?.user?.name
    ?.split(" ")
    .map((n: string) => n[0])
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

      {/* Actions */}
      <div className="flex items-center gap-1.5">
        {session && <NotificationBell />}
        {session && <PushNotifications />}

        <DropdownMenu>
          <DropdownMenuTrigger aria-label="Account menu" className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-accent-ring)]">
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
              {sessionUserImage ? (
                <AvatarImage src={sessionUserImage} />
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
          <DropdownMenuContent align="end" className="w-56">
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
            <AppearanceMenu />
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-red-400"
              onClick={() => signOutAndRedirect("/login")}
            >
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
