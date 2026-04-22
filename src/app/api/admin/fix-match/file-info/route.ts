import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import path from "node:path";
import { prisma } from "@/lib/prisma";

export type FileInfoResponse = {
  plexFilePath:      string | null;
  jellyfinFilePath:  string | null;
  arrTmdbId:         number | null;
  arrTitle:          string | null;
};

export async function GET(request: NextRequest) {
  const session = await requireAuth({ role: "ISSUE_ADMIN" });
  if (session instanceof NextResponse) return session;

  const { searchParams } = new URL(request.url);
  const tmdbIdParam = searchParams.get("tmdbId");
  const tmdbId      = parseInt(tmdbIdParam ?? "", 10);
  const mediaType   = searchParams.get("mediaType") as "MOVIE" | "TV" | null;

  if (!Number.isInteger(tmdbId) || tmdbId <= 0 || !mediaType) {
    return NextResponse.json({ error: "Missing params" }, { status: 400 });
  }

  const [plexItem, jellyfinItem] = await Promise.all([
    prisma.plexLibraryItem.findUnique({
      where: { tmdbId_mediaType: { tmdbId, mediaType } },
      select: { filePath: true },
    }),
    prisma.jellyfinLibraryItem.findUnique({
      where: { tmdbId_mediaType: { tmdbId, mediaType } },
      select: { filePath: true },
    }),
  ]);

  let arrTmdbId: number | null = null;
  const filePath = plexItem?.filePath ?? jellyfinItem?.filePath ?? null;

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
        const res = await fetch(`${arrBaseUrl}/api/v3/${endpoint}`, {
          redirect: "error",
          headers: { "X-Api-Key": arrKeyRow.value, "Content-Type": "application/json" },
          signal: AbortSignal.timeout(8_000),
        });
        if (res.ok) {
          type ArrItem = { tmdbId?: number; path?: string };
          const items = await res.json() as ArrItem[];
          for (const item of items) {
            if (!item.tmdbId || !item.path) continue;
            const normPath = path.posix.normalize(item.path.replace(/\\/g, "/").replace(/\/$/, ""));
            if (normPath === folderPath || folderPath.startsWith(normPath + "/")) {
              arrTmdbId = item.tmdbId;
              break;
            }
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
  } satisfies FileInfoResponse);
}
