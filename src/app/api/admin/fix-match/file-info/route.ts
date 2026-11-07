import { NextResponse } from "next/server";
import { withIssueAdmin } from "@/lib/api-auth";
import { isTmdbIdInRange } from "@/lib/tmdb-id";
import { prisma } from "@/lib/prisma";
import { arrErrorMessage, arrFetch } from "@/lib/arr";
import { configuredArrCfg, enabledArrInstances } from "@/lib/arr-admin";
import { cachedArrList, cachedTmdbTitle, normaliseLibraryPath, pathWithin } from "@/lib/fix-match-shared";
import { getCache } from "@/lib/tmdb-cache";
import { DEFAULT_MEDIA_INSTANCE, isValidMediaInstanceSlug } from "@/lib/media-instances";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { libraryPathFor } from "@/lib/library-path-view";
import { checkRateLimit } from "@/lib/rate-limit";

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
  // A Radarr/Sonarr lookup failed (unreachable, auth, the size cap), so a null
  // arrTmdbId means "could not tell", not "the arr doesn't manage this file".
  arrError:          boolean;
};

// The tmdbId of the arr entry whose folder holds `fullPath`, or null. One
// linear pass with an early exit; a malformed row is skipped (guardrail 5i).
function arrTmdbIdAt(rows: readonly unknown[], fullPath: string): number | null {
  for (const row of rows) {
    if (row === null || typeof row !== "object") continue;
    const { tmdbId, path } = row as { tmdbId?: unknown; path?: unknown };
    if (typeof tmdbId !== "number" || !tmdbId || typeof path !== "string") continue;
    if (pathWithin(path, fullPath)) return tmdbId;
  }
  return null;
}

export const GET = withIssueAdmin(async (request, _ctx, session) => {
  const t = translatorForRequest(request);
  // A name-cache miss downloads a whole Radarr/Sonarr table (up to the 50 MB
  // arr cap), and any MANAGE_ISSUES holder can call this — the same bound as
  // the sibling candidates route.
  if (!checkRateLimit(`fix-match-file-info:${session.user.id}`, 30, 60_000)) {
    return NextResponse.json({ error: t("apiAdmin.fixMatch.tooMany") }, { status: 429 });
  }
  const { searchParams } = new URL(request.url);
  const tmdbIdParam = searchParams.get("tmdbId");
  const tmdbId      = parseInt(tmdbIdParam ?? "", 10);
  const mediaTypeRaw = searchParams.get("mediaType");
  // Validated, not just cast: an arbitrary value reaching the Prisma enum
  // filters below throws PrismaClientValidationError → an unhandled 500 where
  // the sibling candidates route answers 400.
  const mediaType: "MOVIE" | "TV" | null =
    mediaTypeRaw === "MOVIE" || mediaTypeRaw === "TV" ? mediaTypeRaw : null;

  if (!isTmdbIdInRange(tmdbId) || !mediaType) {
    return NextResponse.json({ error: t("apiAdmin.fixMatch.missingParamsShort") }, { status: 400 });
  }

  // Absent ⇒ the default server, so a pre-multi-server caller sees exactly its
  // old plexFilePath/jellyfinFilePath/arrTmdbId values.
  const serverInstanceParam = searchParams.get("serverInstance");
  if (serverInstanceParam !== null && !isValidMediaInstanceSlug(serverInstanceParam)) {
    return NextResponse.json({ error: t("apiAdmin.common.invalidServerInstance", { slug: String(serverInstanceParam) }) }, { status: 400 });
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
  let arrLookupFailed = false;
  // Prefer the requested instance's path; fall back to any instance holding the
  // title so the Radarr/Sonarr hint still resolves when the caller hasn't picked
  // an instance yet and the title lives only on a named server.
  const filePath = plexItem?.filePath
    ?? jellyfinItem?.filePath
    ?? plexInstances.find((r) => r.filePath)?.filePath
    ?? jellyfinInstances.find((r) => r.filePath)?.filePath
    ?? null;

  if (filePath) {
    const service = mediaType === "MOVIE" ? "radarr" : "sonarr";
    // Every enabled instance of the service, through the registry (guardrail
    // 32): a switched-off integration is never called, and a title only a
    // named (4K, anime) instance manages still resolves.
    let instances: Awaited<ReturnType<typeof enabledArrInstances>> = [];
    try {
      instances = await enabledArrInstances(service);
    } catch (err) {
      arrLookupFailed = true;
      console.warn("[fix-match/file-info] arr instance lookup failed:", err instanceof Error ? err.message : err);
    }

    if (instances.length > 0) {
      const fullPath   = normaliseLibraryPath(filePath);
      const folderPath = normaliseLibraryPath(filePath.replace(/\\/g, "/").replace(/\/[^/]+$/, ""));
      const endpoint   = mediaType === "MOVIE" ? "movie" : "series";

      // Cache-first: bad-matches already builds a folder-basename → tmdbId map
      // for the whole arr library (arr:<service>:paths:name, 6h TTL, across
      // every syncable instance). A fix-match dialog open used to always pull
      // the ENTIRE library live; try the warm map's basename match first and
      // only fetch on a miss. Read-only — never write the key from here.
      try {
        // A Jellyfin SERIES row's Path is the series folder itself (not a file
        // inside it), so for TV its own basename is the Sonarr folder name too.
        const names = [folderPath.split("/").pop(), ...(mediaType === "TV" ? [fullPath.split("/").pop()] : [])]
          .filter((n): n is string => !!n);
        const cached = names.length > 0
          ? await getCache<[string, number][]>(`arr:${service}:paths:name`)
          : null;
        if (cached?.length) {
          const map = new Map(cached);
          for (const n of names) {
            const hit = map.get(n);
            if (hit != null) { arrTmdbId = hit; break; }
          }
        }
      } catch (err) {
        console.warn("[fix-match/file-info] arr name cache read failed:", err instanceof Error ? err.message : err);
      }

      // Match on the path itself, not only its parent: a Jellyfin series Path
      // IS the series folder, so its parent is the library root and never
      // equals (or sits under) any Sonarr series path. Stops at the first
      // instance that manages the folder.
      for (const inst of arrTmdbId === null ? instances : []) {
        try {
          const cfg = await configuredArrCfg(inst.service, inst.slug);
          const rows = await cachedArrList(service, inst.slug, () => arrFetch<unknown>(cfg, `/api/v3/${endpoint}`));
          if (!Array.isArray(rows)) throw new Error(`${service} /api/v3/${endpoint} did not answer with a list`);
          const hit = arrTmdbIdAt(rows, fullPath);
          if (hit !== null) { arrTmdbId = hit; break; }
        } catch (err) {
          // The message only: an ArrResponseError's body can quote upstream
          // secrets (guardrail 5e).
          arrLookupFailed = true;
          console.warn("[fix-match/file-info] arr lookup failed:", arrErrorMessage(err));
        }
      }
    }
  }

  const arrTitle = arrTmdbId !== null ? await cachedTmdbTitle(mediaType, arrTmdbId) : null;

  // The arr match above used the full paths; what leaves is the caller's view
  // of them (library-path-view.ts: the path for an ADMIN, the file name for a
  // MANAGE_ISSUES delegate).
  const perms = session.user.permissions;
  const view = (rows: FileInfoInstance[]): FileInfoInstance[] =>
    rows.map((r) => ({ serverInstance: r.serverInstance, filePath: libraryPathFor(perms, r.filePath) }));
  return NextResponse.json({
    plexFilePath:     libraryPathFor(perms, plexItem?.filePath),
    jellyfinFilePath: libraryPathFor(perms, jellyfinItem?.filePath),
    arrTmdbId,
    arrTitle,
    plexServerInstance:     plexItem     ? serverInstance : null,
    jellyfinServerInstance: jellyfinItem ? serverInstance : null,
    plexInstances:     view(plexInstances),
    jellyfinInstances: view(jellyfinInstances),
    arrError:          arrTmdbId === null && arrLookupFailed,
  } satisfies FileInfoResponse);
});
