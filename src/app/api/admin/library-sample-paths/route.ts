import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";

const SAMPLE_COUNT = 6;

function commonPathPrefix(paths: string[]): string {
  if (paths.length === 0) return "";
  const segmented = paths.map((p) => p.replace(/\\/g, "/").split("/").filter(Boolean));
  const first = segmented[0];
  let commonLen = first.length - 1;
  for (const segs of segmented.slice(1)) {
    let i = 0;
    while (i < commonLen && i < segs.length - 1 && first[i] === segs[i]) i++;
    commonLen = i;
    if (commonLen === 0) return "";
  }
  if (commonLen === 0) return "";
  const sep = paths[0].startsWith("/") ? "/" : "";
  return sep + first.slice(0, commonLen).join("/") + "/";
}

function stripPrefix(filePath: string, mountPoint: string): string {
  const n = filePath.replace(/\\/g, "/");
  return mountPoint && n.startsWith(mountPoint) ? n.slice(mountPoint.length) : n;
}

function pickSamples(paths: string[], mountPoint: string): string[] {
  const relative = paths.map((p) => stripPrefix(p, mountPoint)).filter(Boolean);
  if (relative.length <= SAMPLE_COUNT) return relative;
  const indices = Array.from({ length: SAMPLE_COUNT }, (_, i) =>
    Math.round((i / (SAMPLE_COUNT - 1)) * (relative.length - 1))
  );
  return [...new Set(indices)].map((i) => relative[i]);
}

function pickTvShowSamples(paths: string[], mountPoint: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of paths) {
    const rel = stripPrefix(path, mountPoint);
    const showFolder = rel.split("/")[0];
    if (showFolder && !seen.has(showFolder)) {
      seen.add(showFolder);
      result.push(showFolder);
      if (result.length >= SAMPLE_COUNT) break;
    }
  }
  return result;
}

export async function GET() {
  const session = await requireAuth({ role: "ADMIN" });
  if (session instanceof NextResponse) return session;

  const [plexMovieRows, plexTvRows, jellyfinMovieRows, jellyfinTvRows] = await Promise.all([
    prisma.plexLibraryItem.findMany({ where: { filePath: { not: null }, mediaType: "MOVIE" }, select: { filePath: true }, take: 500 }),
    prisma.plexLibraryItem.findMany({ where: { filePath: { not: null }, mediaType: "TV" },    select: { filePath: true }, take: 500 }),
    prisma.jellyfinLibraryItem.findMany({ where: { filePath: { not: null }, mediaType: "MOVIE" }, select: { filePath: true }, take: 500 }),
    prisma.jellyfinLibraryItem.findMany({ where: { filePath: { not: null }, mediaType: "TV" },    select: { filePath: true }, take: 500 }),
  ]);

  const plexMoviePaths    = plexMovieRows.map((r) => r.filePath!);
  const plexTvPaths       = plexTvRows.map((r) => r.filePath!);
  const jellyfinMoviePaths = jellyfinMovieRows.map((r) => r.filePath!);
  const jellyfinTvPaths   = jellyfinTvRows.map((r) => r.filePath!);

  const plexMovieMount    = commonPathPrefix(plexMoviePaths);
  const plexTvMount       = commonPathPrefix(plexTvPaths);
  const jellyfinMovieMount = commonPathPrefix(jellyfinMoviePaths);
  const jellyfinTvMount   = commonPathPrefix(jellyfinTvPaths);

  return NextResponse.json({
    plex: {
      movie: { mountPoint: plexMovieMount,    samples: pickSamples(plexMoviePaths,    plexMovieMount)    },
      tv:    { mountPoint: plexTvMount,       samples: pickTvShowSamples(plexTvPaths, plexTvMount)       },
    },
    jellyfin: {
      movie: { mountPoint: jellyfinMovieMount, samples: pickSamples(jellyfinMoviePaths, jellyfinMovieMount) },
      tv:    { mountPoint: jellyfinTvMount,    samples: pickSamples(jellyfinTvPaths,    jellyfinTvMount)    },
    },
  });
}
