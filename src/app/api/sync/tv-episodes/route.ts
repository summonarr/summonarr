import { NextRequest, NextResponse } from "next/server";
import { plexSettingKey, jellyfinSettingKey } from "@/lib/media-instances";
import { getMediaInstances } from "@/lib/media-instance-registry";
import { prisma } from "@/lib/prisma";
import { getPlexTVEpisodes, getPlexLibrarySections, type PlexTVEpisodeData } from "@/lib/plex";
import { getPlexConfig } from "@/lib/plex-config";
import { getJellyfinTVEpisodes, type JellyfinTVEpisodeData } from "@/lib/jellyfin";
import { getJellyfinConfig } from "@/lib/jellyfin-config";
import { isCronAuthorized, BATCH_TX_TIMEOUT, batchCreateMany, withCronRunRecording } from "@/lib/cron-auth";

// 5-minute timeout: fetching episodes for large TV libraries can be slow
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  if (!(await isCronAuthorized(request))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return withCronRunRecording("tv-episodes-sync", () => syncTvEpisodes());
}

// Rebuilds the shared TVEpisodeCache from EVERY configured server of each type.
//
// TVEpisodeCache has no serverInstance column — episodes are TMDB-anchored and
// every server of one type accumulates into a single `source` namespace — so the
// only correct write is a whole-table replace built from the UNION of all of
// them. This route used to read the DEFAULT server alone and then delete that
// whole namespace, so on a multi-server install the admin's "Sync TV Episodes"
// button destroyed every other server's episode rows and took per-episode
// availability with them.
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

  // ── Plex ──────────────────────────────────────────────────────────────────
  {
    const instances = await getMediaInstances("plex");
    const episodes: Awaited<ReturnType<typeof getPlexTVEpisodes>> = [];
    let configured = 0;
    let complete = true;

    for (const inst of instances) {
      const cfg = await getPlexConfig(inst.slug);
      if (!cfg.url || !cfg.token) continue; // unconfigured contributes nothing and is not a failure
      configured++;
      const serverUrl = cfg.url.replace(/\/$/, "");
      const token = cfg.token;
      const selected = await readSelection(plexSettingKey(inst.slug, "Libraries"));
      try {
        const sections = await getPlexLibrarySections(serverUrl, token);
        // Element-wise, never `push(...array)`: this accumulator unions every
        // configured instance's episodes, so spreading it as call arguments hits
        // V8's argument ceiling on a large library and the catch below downgrades
        // that to `complete = false`, skipping the rewrite entirely.
        for (const e of await getPlexTVEpisodes(serverUrl, token, selected, sections)) episodes.push(e);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[sync/tv-episodes] Plex episode sync failed for instance "${inst.slug}":`, msg);
        results.errors.push(`${errorLabel("Plex", inst.slug, inst.name)}: ${msg}`);
        complete = false;
      }
    }

    if (configured > 0 && complete) {
      await rewrite("plex", episodes);
      results.plex = episodes.length;
    } else if (configured > 0) {
      // Deliberately NOT a partial write — see the all-or-nothing note above.
      results.skipped.push("plex");
      console.warn("[sync/tv-episodes] Plex episode cache left untouched — at least one server failed, and a partial union would wipe it.");
    }
  }

  // ── Jellyfin ──────────────────────────────────────────────────────────────
  {
    const instances = await getMediaInstances("jellyfin");
    const episodes: Awaited<ReturnType<typeof getJellyfinTVEpisodes>> = [];
    let configured = 0;
    let complete = true;

    for (const inst of instances) {
      const cfg = await getJellyfinConfig(inst.slug);
      if (!cfg.url || !cfg.apiKey) continue;
      configured++;
      const baseUrl = cfg.url.replace(/\/$/, "");
      const apiKey = cfg.apiKey;
      const selected = await readSelection(jellyfinSettingKey(inst.slug, "Libraries"));
      try {
        // Element-wise — see the Plex arm above.
        for (const e of await getJellyfinTVEpisodes(baseUrl, apiKey, selected)) episodes.push(e);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[sync/tv-episodes] Jellyfin episode sync failed for instance "${inst.slug}":`, msg);
        results.errors.push(`${errorLabel("Jellyfin", inst.slug, inst.name)}: ${msg}`);
        complete = false;
      }
    }

    if (configured > 0 && complete) {
      await rewrite("jellyfin", episodes);
      results.jellyfin = episodes.length;
    } else if (configured > 0) {
      results.skipped.push("jellyfin");
      console.warn("[sync/tv-episodes] Jellyfin episode cache left untouched — at least one server failed, and a partial union would wipe it.");
    }
  }

  return NextResponse.json(results);
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
  if (!row?.value) return undefined;
  const parsed = new Set(row.value.split(",").map((k) => k.trim()).filter(Boolean));
  return parsed.size ? parsed : undefined;
}

// Whole-table replace for one source, inside the advisory lock that serializes
// every wholesale rewrite of that namespace — the orchestrator, this route, and
// the per-source resyncs all share it, so two runs can't interleave their
// delete/insert phases and leave the cache empty or duplicated.
async function rewrite(
  source: "plex" | "jellyfin",
  episodes: Array<PlexTVEpisodeData | JellyfinTVEpisodeData>,
): Promise<void> {
  await prisma.$transaction(
    async (tx) => {
      // Tagged template, not Unsafe: the existing rewrite sites use this exact
      // shape and the suite observes it.
      if (source === "plex") await tx.$executeRaw`SELECT pg_advisory_xact_lock(2002, 1)`;
      else await tx.$executeRaw`SELECT pg_advisory_xact_lock(2002, 2)`;
      await tx.tVEpisodeCache.deleteMany({ where: { source } });
      if (episodes.length > 0) {
        await batchCreateMany(tx.tVEpisodeCache, episodes.map((e) => ({ source, ...e })));
      }
    },
    { timeout: BATCH_TX_TIMEOUT },
  );
}

