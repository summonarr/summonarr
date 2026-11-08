import { NextResponse } from "next/server";
import { withIssueAdmin } from "@/lib/api-auth";
import { isTmdbIdInRange } from "@/lib/tmdb-id";
import { prisma } from "@/lib/prisma";
import { arrErrorMessage, arrFetch } from "@/lib/arr";
import { configuredArrCfg, enabledArrInstances } from "@/lib/arr-admin";
import { cachedArrList, cachedTmdbTitle, normaliseLibraryPath, pathWithin } from "@/lib/fix-match-shared";
import { cachedArrNameIndex } from "@/lib/bad-matches";
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

// Cache-first: the library page and the bad-match list keep one Radarr/Sonarr
// folder map for the whole arr library (bad-matches.ts loadArrPathIndex,
// across every syncable instance). A fix-match dialog open used to always pull
// the ENTIRE library live; that map's basename index is tried first and the
// live lists only on a miss. Read-only — nothing is built or written from
// here, and only a tmdbId comes back: a basename two titles share gives none,
// so the exact lookup decides it. A hit is as fresh as that map (its own TTL);
// the hint is display-only, which is the trade.
async function nameIndexHit(mediaType: "MOVIE" | "TV", fullPath: string, folderPath: string): Promise<number | null> {
  // A Jellyfin SERIES row's Path is the series folder itself (not a file
  // inside it), so for TV its own basename is the Sonarr folder name too.
  const names = [folderPath.split("/").pop(), ...(mediaType === "TV" ? [fullPath.split("/").pop()] : [])]
    .filter((n): n is string => !!n);
  if (names.length === 0) return null;
  try {
    const byName = await cachedArrNameIndex(mediaType);
    if (!byName) return null;
    for (const n of names) {
      const hit = byName.get(n);
      if (hit != null) return hit;
    }
  } catch (err) {
    console.warn("[fix-match/file-info] arr name cache read failed:", err instanceof Error ? err.message : err);
  }
  return null;
}

// The live lookup: each instance's whole list (cachedArrList keeps it for a
// minute), matched on the path itself, not only its parent — a Jellyfin
// series Path IS the series folder, so its parent is the library root and
// never equals (or sits under) any Sonarr series path. Stops at the first
// instance that manages the folder.
async function liveArrHit(
  instances: Awaited<ReturnType<typeof enabledArrInstances>>,
  mediaType: "MOVIE" | "TV",
  fullPath: string,
): Promise<{ tmdbId: number | null; failed: boolean }> {
  const service = mediaType === "MOVIE" ? "radarr" : "sonarr";
  const endpoint = mediaType === "MOVIE" ? "movie" : "series";
  let failed = false;
  for (const inst of instances) {
    try {
      const cfg = await configuredArrCfg(inst.service, inst.slug);
      const rows = await cachedArrList(service, inst.slug, () => arrFetch<unknown>(cfg, `/api/v3/${endpoint}`));
      if (!Array.isArray(rows)) throw new Error(`${service} /api/v3/${endpoint} did not answer with a list`);
      const hit = arrTmdbIdAt(rows, fullPath);
      if (hit !== null) return { tmdbId: hit, failed };
    } catch (err) {
      // The message only: an ArrResponseError's body can quote upstream
      // secrets (guardrail 5e).
      failed = true;
      console.warn("[fix-match/file-info] arr lookup failed:", arrErrorMessage(err));
    }
  }
  return { tmdbId: null, failed };
}

// Which TMDB id Radarr/Sonarr have for the folder holding `filePath`, across
// every enabled instance of the service, through the registry (guardrail 32):
// a switched-off integration is never called, and a title only a named (4K,
// anime) instance manages still resolves. `failed` = a lookup failed, so a
// null id means "could not tell", not "not managed".
async function arrTmdbIdFor(filePath: string, mediaType: "MOVIE" | "TV"): Promise<{ tmdbId: number | null; failed: boolean }> {
  let instances: Awaited<ReturnType<typeof enabledArrInstances>>;
  try {
    instances = await enabledArrInstances(mediaType === "MOVIE" ? "radarr" : "sonarr");
  } catch (err) {
    console.warn("[fix-match/file-info] arr instance lookup failed:", err instanceof Error ? err.message : err);
    return { tmdbId: null, failed: true };
  }
  if (instances.length === 0) return { tmdbId: null, failed: false };
  const fullPath   = normaliseLibraryPath(filePath);
  const folderPath = normaliseLibraryPath(filePath.replace(/\\/g, "/").replace(/\/[^/]+$/, ""));
  const cached = await nameIndexHit(mediaType, fullPath, folderPath);
  if (cached !== null) return { tmdbId: cached, failed: false };
  return liveArrHit(instances, mediaType, fullPath);
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

  // Prefer the requested instance's path; fall back to any instance holding the
  // title so the Radarr/Sonarr hint still resolves when the caller hasn't picked
  // an instance yet and the title lives only on a named server.
  const filePath = plexItem?.filePath
    ?? jellyfinItem?.filePath
    ?? plexInstances.find((r) => r.filePath)?.filePath
    ?? jellyfinInstances.find((r) => r.filePath)?.filePath
    ?? null;
  const arr = filePath ? await arrTmdbIdFor(filePath, mediaType) : { tmdbId: null, failed: false };
  const arrTmdbId = arr.tmdbId;

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
    arrError:          arrTmdbId === null && arr.failed,
  } satisfies FileInfoResponse);
});
