import { NextRequest, NextResponse } from "next/server";
import { plexSettingKey, jellyfinSettingKey } from "@/lib/media-instances";
import { getMediaInstances, type MediaInstanceConfig } from "@/lib/media-instance-registry";
import { prisma } from "@/lib/prisma";
import { getPlexTVEpisodes, getPlexLibrarySections } from "@/lib/plex";
import { getPlexConfig } from "@/lib/plex-config";
import { buildPlexShowKeyMap } from "@/lib/plex-legacy-resolve";
import { getJellyfinTVEpisodes } from "@/lib/jellyfin";
import { getJellyfinConfig } from "@/lib/jellyfin-config";
import { earliestAddedPerEpisode, replaceEpisodeCacheForSource, type EpisodeCacheRow } from "@/lib/episode-cache";
import { parseLibrarySelection } from "@/lib/library-resync";
import { getCronActor } from "@/lib/cron-auth";
import { readJsonCappedOr } from "@/lib/body-size";
import { libraryJobResponse, startLibraryJob, wantsBackgroundRun } from "@/lib/library-sync-jobs";
import { CRON_DEGRADED_HEADER, withCronRunRecording } from "@/lib/cron-history";
import { translatorForRequest } from "@/lib/i18n/server-locale";

// Allow up to 5 minutes: fetching every episode of a large TV library is slow.
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  const t = translatorForRequest(request);
  const actor = await getCronActor(request);
  if (!actor) {
    return NextResponse.json({ error: t("apiAdmin.common.forbidden") }, { status: 403 });
  }
  // Read only for the background flag; no body is the request every caller
  // has always sent.
  const rawBody = await readJsonCappedOr<Record<string, unknown>>(request, 8192, {});
  if (rawBody instanceof NextResponse) return rawBody;

  const run = () => withCronRunRecording("tv-episodes-sync", () => syncTvEpisodes());
  // An admin's { async: true } runs in the background and is polled with GET
  // ?job= (library-sync-jobs.ts): the rebuild walks every episode of every
  // server and outlasts a reverse proxy's hold. A second click joins the job
  // already running. Every other caller keeps the synchronous answer.
  if (actor.trigger === "admin" && wantsBackgroundRun(rawBody)) {
    return startLibraryJob(actor.userId, "tv-episodes", run);
  }
  return run();
}

// The background rebuild's answer, for the admin who started it.
export async function GET(request: NextRequest) {
  const t = translatorForRequest(request);
  const actor = await getCronActor(request);
  if (!actor || actor.trigger !== "admin") {
    return NextResponse.json({ error: t("apiAdmin.common.forbidden") }, { status: 403 });
  }
  return libraryJobResponse(actor.userId, request.nextUrl.searchParams.get("job") ?? "", t);
}

type EpisodeSource = "plex" | "jellyfin";

// Rebuilds the shared TVEpisodeCache from EVERY configured server of each type.
//
// TVEpisodeCache has no serverInstance column — episodes are TMDB-anchored and
// every server of one type accumulates into a single `source` namespace — so the
// only correct write is a whole-table replace built from the UNION of all of
// them. Reading only the DEFAULT server and then replacing the whole namespace
// would destroy every other server's episode rows (and their per-episode
// availability) on a multi-server install.
//
// The union is ALL-OR-NOTHING, mirroring the orchestrator's gate (guardrail 35):
// if any configured instance's fetch fails, its episodes are missing from the
// union, and rewriting on a partial picture would wipe the down server's rows
// for the length of its outage. In that case the cache is left exactly as it is
// and the failure is reported.
//
// Config is read with setting.findUnique only (getMediaInstances + a per-slug
// getPlexConfig/getJellyfinConfig, skipping unconfigured instances) — the same
// read-shape contract the other per-instance readers are held to.
async function syncTvEpisodes() {
  const results = {
    plex: 0,
    jellyfin: 0,
    errors: [] as string[],
    skipped: [] as string[],
  };

  // One source failing never stops the other.
  const plex = await rebuildEpisodeSource("plex", plexInstanceEpisodes, results.errors);
  if (plex === "skipped") results.skipped.push("plex");
  else results.plex = plex;
  const jellyfin = await rebuildEpisodeSource("jellyfin", jellyfinInstanceEpisodes, results.errors);
  if (jellyfin === "skipped") results.skipped.push("jellyfin");
  else results.jellyfin = jellyfin;

  // A source left untouched is a failed run for the cron history
  // (withCronRunRecording reads X-Cron-Degraded), even though the answer stays
  // 200 like the orchestrator's: the healthy source's rewrite still happened.
  return NextResponse.json(
    results,
    results.skipped.length > 0 ? { headers: { [CRON_DEGRADED_HEADER]: results.skipped.join(",") } } : undefined,
  );
}

/**
 * One source's whole-namespace rebuild: every registered server's episodes,
 * then ONE replace. Returns the rows written (0 with nothing configured), or
 * "skipped" when the cache was left untouched — a server failed (a partial
 * union would wipe its rows), or the registry or the write itself failed.
 * Failures are reported in `errors`, never thrown.
 */
async function rebuildEpisodeSource(
  source: EpisodeSource,
  instanceEpisodes: (inst: MediaInstanceConfig) => Promise<EpisodeCacheRow[] | null>,
  errors: string[],
): Promise<number | "skipped"> {
  const service = source === "plex" ? "Plex" : "Jellyfin";
  let instances: MediaInstanceConfig[];
  try {
    instances = await getMediaInstances(source);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[sync/tv-episodes] ${service} server list failed:`, msg);
    errors.push(`${service}: ${msg}`);
    return "skipped";
  }

  const episodes: EpisodeCacheRow[] = [];
  let configured = 0;
  let complete = true;
  for (const inst of instances) {
    try {
      const fetched = await instanceEpisodes(inst);
      if (fetched === null) continue; // unconfigured contributes nothing and is not a failure
      configured++;
      // Element-wise, never `push(...array)`: this accumulator unions every
      // configured instance's episodes, so spreading it as call arguments hits
      // V8's argument ceiling on a large library and the catch below would
      // downgrade that to an incomplete union, skipping the rewrite entirely.
      for (const e of fetched) episodes.push(e);
    } catch (err) {
      // A config or selection read that failed is a server we could not read:
      // counted as configured, so its rows are never wiped by a partial union.
      configured++;
      complete = false;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[sync/tv-episodes] ${service} episode sync failed for instance "${inst.slug}":`, msg);
      errors.push(`${errorLabel(service, inst.slug, inst.name)}: ${msg}`);
    }
  }
  if (configured === 0) return 0;
  if (!complete) {
    // Deliberately NOT a partial write — see the all-or-nothing note above.
    console.warn(`[sync/tv-episodes] ${service} episode cache left untouched — at least one server failed, and a partial union would wipe it.`);
    return "skipped";
  }

  // One row per (show, season, episode): two servers holding the same show
  // count it once, as the cache stores it.
  const rows = earliestAddedPerEpisode(episodes);
  try {
    // An empty answer from servers that all replied is not proof the library is
    // empty (a scan in progress, a recreated library): a whole-namespace swap
    // of nothing would wipe every stored episode. Hold it, as the library sync
    // does for a short Plex answer; a deliberate removal is the admin Resync.
    if (rows.length === 0 && (await prisma.tVEpisodeCache.count({ where: { source } })) > 0) {
      console.warn(`[sync/tv-episodes] ${service} returned no episodes while the cache holds some — left untouched.`);
      errors.push(`${service}: no episodes returned; cache kept`);
      return "skipped";
    }
    // The staged load + one short swap under advisory lock 2002,1 (plex) /
    // 2002,2 (jellyfin), shared with every other writer of the namespace, so
    // two runs can't interleave their delete/insert phases.
    await replaceEpisodeCacheForSource(source, rows);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[sync/tv-episodes] ${service} episode cache write failed:`, msg);
    errors.push(`${service}: ${msg}`);
    return "skipped";
  }
  return rows.length;
}

// One Plex server's episodes; null when it is not configured. The show map is
// built with legacy-agent shows resolved, as the orchestrator does — the
// internal fallback walk can't see them and this rewrite is whole-table.
async function plexInstanceEpisodes(inst: MediaInstanceConfig): Promise<EpisodeCacheRow[] | null> {
  const cfg = await getPlexConfig(inst.slug);
  if (!cfg.url || !cfg.token) return null;
  const serverUrl = cfg.url.replace(/\/$/, "");
  const token = cfg.token;
  const selected = await readSelection(plexSettingKey(inst.slug, "Libraries"));
  const sections = await getPlexLibrarySections(serverUrl, token);
  const showKeys = await buildPlexShowKeyMap(serverUrl, token, selected, sections);
  return getPlexTVEpisodes(serverUrl, token, selected, sections, showKeys);
}

// One Jellyfin server's episodes; null when it is not configured.
async function jellyfinInstanceEpisodes(inst: MediaInstanceConfig): Promise<EpisodeCacheRow[] | null> {
  const cfg = await getJellyfinConfig(inst.slug);
  if (!cfg.url || !cfg.apiKey) return null;
  const selected = await readSelection(jellyfinSettingKey(inst.slug, "Libraries"));
  return getJellyfinTVEpisodes(cfg.url.replace(/\/$/, ""), cfg.apiKey, selected);
}

// These strings are shown to the admin, not logged, so the DEFAULT server keeps
// the exact "Plex: …" / "Jellyfin: …" prefix it has always had — mediaInstanceLabel
// is lowercase and log-shaped. Named servers are qualified so a multi-server
// operator can tell which one failed.
function errorLabel(service: "Plex" | "Jellyfin", slug: string, name: string): string {
  return slug === "" ? service : `${service} (${name})`;
}

// A library selection is per server (a Plex section key is only meaningful on
// the server it came from). Unset ⇒ undefined ⇒ every library on that server.
async function readSelection(key: string): Promise<Set<string> | undefined> {
  const row = await prisma.setting.findUnique({ where: { key } });
  return parseLibrarySelection(row?.value);
}
