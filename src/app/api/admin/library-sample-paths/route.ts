import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { DEFAULT_MEDIA_INSTANCE } from "@/lib/media-instances";

const SAMPLE_COUNT = 6;

// Longest shared directory prefix across paths (excludes the final filename
// segment), used as the inferred library mount point to strip in the UI.
// Only ever hand it ONE server instance's paths — see the query scope below.
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

// Evenly-spaced sample of mount-relative paths (up to SAMPLE_COUNT) so the UI
// shows a representative spread rather than just the first few.
function pickSamples(paths: string[], mountPoint: string): string[] {
  const relative = paths.map((p) => stripPrefix(p, mountPoint)).filter(Boolean);
  if (relative.length <= SAMPLE_COUNT) return relative;
  const indices = Array.from({ length: SAMPLE_COUNT }, (_, i) =>
    Math.round((i / (SAMPLE_COUNT - 1)) * (relative.length - 1))
  );
  return [...new Set(indices)].map((i) => relative[i]);
}

// Sample of distinct show folders (first path segment) rather than per-episode
// paths, so the TV preview lists shows instead of many files from one show.
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

export const GET = withAdmin(async (_req, _ctx, _session) => {
  // Scoped to the DEFAULT server instance, which is the one the shared
  // plex/jellyfin{Movie,Tv}PathStripPrefix Settings this preview accompanies
  // apply to. Mixing instances would hand commonPathPrefix two unrelated
  // bind-mount roots (/plexmedia/… and /mnt/nas/video/…), collapsing the
  // inferred mount to "" — the admin would then be shown full absolute paths
  // as if that were the default server's mount while typing a prefix against
  // it. A per-instance selector for this preview is a later, additive change.
  const scope = { serverInstance: DEFAULT_MEDIA_INSTANCE, filePath: { not: null } } as const;
  const [plexMovieRows, plexTvRows, jellyfinMovieRows, jellyfinTvRows] = await Promise.all([
    prisma.plexLibraryItem.findMany({ where: { ...scope, mediaType: "MOVIE" }, select: { filePath: true }, take: 500 }),
    prisma.plexLibraryItem.findMany({ where: { ...scope, mediaType: "TV" },    select: { filePath: true }, take: 500 }),
    prisma.jellyfinLibraryItem.findMany({ where: { ...scope, mediaType: "MOVIE" }, select: { filePath: true }, take: 500 }),
    prisma.jellyfinLibraryItem.findMany({ where: { ...scope, mediaType: "TV" },    select: { filePath: true }, take: 500 }),
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
});
