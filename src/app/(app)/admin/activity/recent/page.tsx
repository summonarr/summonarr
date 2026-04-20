import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { Card } from "@/components/ui/card";
import { posterUrl } from "@/lib/tmdb-types";
import { ActivityFilterBar } from "@/components/admin/activity-filter-bar";
import { Clock, Film, Tv2 } from "lucide-react";

export const dynamic = "force-dynamic";

interface RecentItem {
  tmdbId: number;
  title: string;
  mediaType: "MOVIE" | "TV";
  year: string | null;
  addedAt: Date;
  source: "plex" | "jellyfin";
  posterPath: string | null;
}

function formatRelativeTime(date: Date): string {
  const diff = Date.now() - date.getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export default async function RecentlyAddedPage() {
  const session = await auth();
  if (!session || session.user.role !== "ADMIN") redirect("/");

  const [plexItems, jellyfinItems] = await Promise.all([
    prisma.plexLibraryItem.findMany({
      where: { addedAt: { not: null } },
      orderBy: { addedAt: "desc" },
      take: 60,
      select: { tmdbId: true, mediaType: true, title: true, year: true, addedAt: true },
    }),
    prisma.jellyfinLibraryItem.findMany({
      where: { addedAt: { not: null } },
      orderBy: { addedAt: "desc" },
      take: 60,
      select: { tmdbId: true, mediaType: true, title: true, year: true, addedAt: true },
    }),
  ]);

  const merged = new Map<string, RecentItem>();
  for (const item of plexItems) {
    const key = `${item.mediaType}:${item.tmdbId}`;
    merged.set(key, {
      tmdbId: item.tmdbId,
      title: item.title ?? "Unknown",
      mediaType: item.mediaType as "MOVIE" | "TV",
      year: item.year ?? null,
      addedAt: item.addedAt!,
      source: "plex",
      posterPath: null,
    });
  }
  for (const item of jellyfinItems) {
    const key = `${item.mediaType}:${item.tmdbId}`;
    const existing = merged.get(key);
    if (!existing || item.addedAt!.getTime() > existing.addedAt.getTime()) {
      merged.set(key, {
        tmdbId: item.tmdbId,
        title: item.title ?? "Unknown",
        mediaType: item.mediaType as "MOVIE" | "TV",
        year: item.year ?? null,
        addedAt: item.addedAt!,
        source: "jellyfin",
        posterPath: null,
      });
    }
  }
  let items = Array.from(merged.values())
    .sort((a, b) => b.addedAt.getTime() - a.addedAt.getTime())
    .slice(0, 60);

  if (items.length > 0) {
    const cacheKeys = items.map((i) =>
      `${i.mediaType === "TV" ? "tv" : "movie"}:${i.tmdbId}:details`,
    );
    const cacheRows = await prisma.tmdbCache.findMany({
      where: { key: { in: cacheKeys } },
      select: { key: true, data: true },
    });
    const posterByKey = new Map<string, string | null>();
    for (const row of cacheRows) {
      try {
        const parsed = JSON.parse(row.data) as { poster_path?: string | null; posterPath?: string | null };
        const path = parsed.poster_path ?? parsed.posterPath ?? null;
        posterByKey.set(row.key, posterUrl(path, "w342"));
      } catch { }
    }
    items = items.map((i) => ({
      ...i,
      posterPath: posterByKey.get(`${i.mediaType === "TV" ? "tv" : "movie"}:${i.tmdbId}:details`) ?? null,
    }));
  }

  return (
    <div>
      <ActivityFilterBar />

      <div className="mb-6">
        <h1 className="text-2xl font-bold mb-1 flex items-center gap-2">
          <Clock className="w-6 h-6 text-zinc-400" />
          Recently Added
        </h1>
        <p className="text-zinc-400 text-sm">
          {items.length > 0
            ? `${items.length} items recently added to your media server`
            : "Items recently added to your media server"}
        </p>
      </div>

      {items.length === 0 ? (
        <Card className="bg-zinc-900 border-zinc-800 p-8 text-center">
          <p className="text-zinc-500 text-sm">No recently added items found. Run a library sync first.</p>
        </Card>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
          {items.map((item, i) => {
            const mediaHref = item.mediaType === "TV" ? `/tv/${item.tmdbId}` : `/movie/${item.tmdbId}`;
            const activityHref = `/admin/activity/media/${item.tmdbId}`;

            return (
              <div key={`${item.mediaType}-${item.tmdbId}-${i}`} className="group">
                <div className="relative aspect-[2/3] bg-zinc-800 rounded-lg overflow-hidden mb-2">
                  {item.posterPath ? (
                    <Link href={mediaHref}>
                      <Image
                        src={item.posterPath}
                        alt={item.title}
                        fill
                        className="object-cover group-hover:scale-105 transition-transform duration-200"
                        unoptimized
                      />
                    </Link>
                  ) : (
                    <div className="w-full h-full flex flex-col items-center justify-center gap-2 p-3">
                      {item.mediaType === "TV" ? (
                        <Tv2 className="w-8 h-8 text-zinc-600" />
                      ) : (
                        <Film className="w-8 h-8 text-zinc-600" />
                      )}
                      <p className="text-zinc-500 text-[10px] text-center leading-tight">{item.title}</p>
                    </div>
                  )}
                  {}
                  <div className="absolute top-1.5 right-1.5">
                    <span className={`text-[9px] px-1.5 py-0.5 rounded font-semibold ${
                      item.source === "plex" ? "bg-amber-500/90 text-black" : "bg-purple-500/90 text-white"
                    }`}>
                      {item.source === "plex" ? "Plex" : "JF"}
                    </span>
                  </div>
                  {}
                  <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-end p-2">
                    <Link
                      href={activityHref}
                      className="text-[10px] text-indigo-300 hover:text-indigo-200 font-medium"
                    >
                      Activity ↗
                    </Link>
                  </div>
                </div>
                <div className="min-w-0">
                  <Link href={mediaHref} className="text-xs font-medium text-white hover:text-indigo-400 transition-colors truncate block">
                    {item.title}
                  </Link>
                  <p className="text-[10px] text-zinc-500">
                    {item.year && <span>{item.year} · </span>}
                    {formatRelativeTime(item.addedAt)}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
