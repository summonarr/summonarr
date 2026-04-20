"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { Search, Film, Tv2, Loader2 } from "lucide-react";
import { Input } from "@/components/ui/input";
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
import Image from "next/image";
import { posterUrl, type TmdbMedia } from "@/lib/tmdb-types";

type MediaFilter = "all" | "movie" | "tv";

function SearchBar({ showPlex, showJellyfin }: { showPlex: boolean; showJellyfin: boolean }) {
  const router = useRouter();
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
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    abortRef.current?.abort();
    if (!query.trim()) { setResults([]); setOpen(false); return; }

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

    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); abortRef.current?.abort(); };
  }, [query, filter]);

  function handleSelect(media: TmdbMedia) {
    setOpen(false);
    setQuery("");
    router.push(`/${media.mediaType}/${media.id}`);
  }

  const filterLabels: { value: MediaFilter; label: string }[] = [
    { value: "all", label: "All" },
    { value: "movie", label: "Movies" },
    { value: "tv", label: "TV" },
  ];

  return (
    <div ref={containerRef} className="relative flex-1 max-w-md md:max-w-lg lg:max-w-xl xl:max-w-2xl">
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500 pointer-events-none" />
      {loading && (
        <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500 animate-spin" />
      )}
      <Input
        placeholder="Search movies & TV..."
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => results.length > 0 && setOpen(true)}
        className="pl-9 pr-9 bg-zinc-900 border-zinc-700 text-sm"
      />
      {open && (
        <div className="absolute top-full mt-2 left-0 right-0 z-50 rounded-lg bg-zinc-900 border border-zinc-700 shadow-xl overflow-hidden">
          <div className="flex gap-1 px-3 pt-2 pb-1.5 border-b border-zinc-800">
            {filterLabels.map(({ value, label }) => (
              <button
                key={value}
                onMouseDown={(e) => { e.preventDefault(); setFilter(value); }}
                className={`flex items-center gap-1 px-2.5 py-0.5 rounded text-xs font-medium transition-colors ${
                  filter === value
                    ? "bg-indigo-600 text-white"
                    : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800"
                }`}
              >
                {value === "movie" && <Film className="w-3 h-3" />}
                {value === "tv" && <Tv2 className="w-3 h-3" />}
                {label}
              </button>
            ))}
          </div>
          {results.length > 0 ? results.map((media) => {
            const poster = posterUrl(media.posterPath, "w342");
            return (
              <button
                key={`${media.mediaType}-${media.id}`}
                onClick={() => handleSelect(media)}
                className="flex items-center gap-3 w-full px-3 py-2.5 hover:bg-zinc-800 transition-colors text-left"
              >
                <div className="relative w-9 h-14 rounded shrink-0 bg-zinc-700 overflow-hidden">
                  {poster ? (
                    <Image src={poster} alt={media.title} fill className="object-cover" sizes="36px" />
                  ) : (
                    <div className="absolute inset-0 flex items-center justify-center text-zinc-600">
                      {media.mediaType === "movie" ? <Film className="w-4 h-4" /> : <Tv2 className="w-4 h-4" />}
                    </div>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-white truncate">{media.title}</p>
                  <p className="text-xs text-zinc-400">
                    {media.releaseYear && `${media.releaseYear} · `}
                    {media.mediaType === "movie" ? "Movie" : "TV Show"}
                    {showPlex && media.plexAvailable && (
                      <span className="ml-1.5 text-[#e5a00d] font-medium">· On Plex</span>
                    )}
                    {showJellyfin && media.jellyfinAvailable && (
                      <span className="ml-1.5 text-[#00a4dc] font-medium">· On Jellyfin</span>
                    )}
                  </p>
                </div>
              </button>
            );
          }) : (
            <p className="px-3 py-4 text-sm text-zinc-500 text-center">No results</p>
          )}
        </div>
      )}
    </div>
  );
}

export function Header() {
  const router = useRouter();
  const { data: session } = useSession();
  const role = session?.user?.role;
  const provider = session?.user?.provider;
  const showPlex = role === "ADMIN" || role === "ISSUE_ADMIN" || provider === "plex";
  const showJellyfin = role === "ADMIN" || role === "ISSUE_ADMIN" || provider === "jellyfin" || provider === "jellyfin-quickconnect";
  const initials = session?.user?.name
    ?.split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase();

  return (
    <header className="sticky top-0 z-30 flex items-center gap-4 px-6 py-3 bg-zinc-950/80 backdrop-blur border-b border-zinc-800">
      <SearchBar showPlex={showPlex} showJellyfin={showJellyfin} />

      <div className="flex items-center gap-2 ml-auto">
        {session && <PushNotifications />}

        <DropdownMenu>
          <DropdownMenuTrigger className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">
            <Avatar className="h-9 w-9 cursor-pointer">
              <AvatarImage src={session?.user?.image ?? ""} />
              <AvatarFallback className="bg-indigo-700 text-white text-xs">
                {initials ?? "?"}
              </AvatarFallback>
            </Avatar>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <div className="px-1.5 py-1.5 text-sm font-medium text-zinc-200">
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
      </div>
    </header>
  );
}
