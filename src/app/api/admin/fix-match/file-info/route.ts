import { NextResponse } from "next/server";
import { withIssueAdmin } from "@/lib/api-auth";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { arrFetch } from "@/lib/arr";
import { DEFAULT_MEDIA_INSTANCE, isValidMediaInstanceSlug } from "@/lib/media-instances";

// One configured server that holds this title, with the path it holds it at.
export type FileInfoInstance = {
  serverInstance: string;
  filePath:       string | null;
};

export type FileInfoResponse = {
  plexFilePath:      string | null;
  jellyfinFilePath:  string | null;
  arrTmdbId:         number | null;
  arrTitle:          string | null;

  // The four fields below are purely ADDITIVE — the four above keep their exact
  // pre-multi-server values, so an older consumer needs no change.
  //
  // Which instance the two filePaths above came from — the requested slug when
  // that server actually holds the title, else null.
  plexServerInstance:     string | null;
  jellyfinServerInstance: string | null;
  // EVERY configured server holding this title, so an issue-driven picker (which
  // starts from a tmdbId with no library row in hand) can thread the right slug
  // without a second round trip — one entry ⇒ pick it, several ⇒ ask the admin.
  plexInstances:     FileInfoInstance[];
  jellyfinInstances: FileInfoInstance[];
};

export const GET = withIssueAdmin(async (request, _ctx, _session) => {
  const { searchParams } = new URL(request.url);
  const tmdbIdParam = searchParams.get("tmdbId");
  const tmdbId      = parseInt(tmdbIdParam ?? "", 10);
  const mediaType   = searchParams.get("mediaType") as "MOVIE" | "TV" | null;

  if (!Number.isInteger(tmdbId) || tmdbId <= 0 || !mediaType) {
    return NextResponse.json({ error: "Missing params" }, { status: 400 });
  }

  // Absent ⇒ the default server, so a pre-multi-server caller sees exactly its
  // old plexFilePath/jellyfinFilePath/arrTmdbId values.
  const serverInstanceParam = searchParams.get("serverInstance");
  if (serverInstanceParam !== null && !isValidMediaInstanceSlug(serverInstanceParam)) {
    return NextResponse.json({ error: `invalid serverInstance: ${serverInstanceParam}` }, { status: 400 });
  }
  const serverInstance = serverInstanceParam ?? DEFAULT_MEDIA_INSTANCE;

  const [plexItem, jellyfinItem, plexInstances, jellyfinInstances] = await Promise.all([
    prisma.plexLibraryItem.findFirst({
      where: { tmdbId, mediaType, serverInstance },
      select: { filePath: true },
    }),
    prisma.jellyfinLibraryItem.findFirst({
      where: { tmdbId, mediaType, serverInstance },
      select: { filePath: true },
    }),
    prisma.plexLibraryItem.findMany({
      where: { tmdbId, mediaType },
      select: { serverInstance: true, filePath: true },
      orderBy: { serverInstance: "asc" },
    }),
    prisma.jellyfinLibraryItem.findMany({
      where: { tmdbId, mediaType },
      select: { serverInstance: true, filePath: true },
      orderBy: { serverInstance: "asc" },
    }),
  ]);

  let arrTmdbId: number | null = null;
  // Prefer the requested instance's path; fall back to any instance holding the
  // title so the Radarr/Sonarr hint still resolves when the caller hasn't picked
  // an instance yet and the title lives only on a named server.
  const filePath = plexItem?.filePath
    ?? jellyfinItem?.filePath
    ?? plexInstances.find((r) => r.filePath)?.filePath
    ?? jellyfinInstances.find((r) => r.filePath)?.filePath
    ?? null;

  if (filePath) {
    const arrUrlKey = mediaType === "MOVIE" ? "radarrUrl"    : "sonarrUrl";
    const arrKeyKey = mediaType === "MOVIE" ? "radarrApiKey" : "sonarrApiKey";

    const [arrUrlRow, arrKeyRow] = await Promise.all([
      prisma.setting.findUnique({ where: { key: arrUrlKey } }),
      prisma.setting.findUnique({ where: { key: arrKeyKey } }),
    ]);

    if (arrUrlRow?.value && arrKeyRow?.value) {
      const arrBaseUrl = arrUrlRow.value.replace(/\/$/, "");
      const folderPath = path.posix.normalize(filePath.replace(/\\/g, "/").replace(/\/[^/]+$/, ""));
      const endpoint   = mediaType === "MOVIE" ? "movie" : "series";

      try {
        type ArrItem = { tmdbId?: number; path?: string };
        const items = await arrFetch<ArrItem[]>(
          { url: arrBaseUrl, apiKey: arrKeyRow.value },
          `/api/v3/${endpoint}`,
        );
        for (const item of items) {
          if (!item.tmdbId || !item.path) continue;
          const normPath = path.posix.normalize(item.path.replace(/\\/g, "/").replace(/\/$/, ""));
          if (normPath === folderPath || folderPath.startsWith(normPath + "/")) {
            arrTmdbId = item.tmdbId;
            break;
          }
        }
      } catch { }
    }
  }

  let arrTitle: string | null = null;
  if (arrTmdbId !== null) {
    const cacheKey = `${mediaType === "MOVIE" ? "movie" : "tv"}:${arrTmdbId}:details`;
    const cacheRow = await prisma.tmdbCache.findUnique({ where: { key: cacheKey }, select: { data: true } });
    if (cacheRow) {
      try {
        const p = JSON.parse(cacheRow.data) as { title?: string; name?: string };
        arrTitle = p.title ?? p.name ?? null;
      } catch { }
    }
  }

  return NextResponse.json({
    plexFilePath:     plexItem?.filePath ?? null,
    jellyfinFilePath: jellyfinItem?.filePath ?? null,
    arrTmdbId,
    arrTitle,
    plexServerInstance:     plexItem     ? serverInstance : null,
    jellyfinServerInstance: jellyfinItem ? serverInstance : null,
    plexInstances,
    jellyfinInstances,
  } satisfies FileInfoResponse);
});
