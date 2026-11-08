// The admin's library Resync (/api/sync/plex, /api/sync/jellyfin) and TMDB
// library warm (/api/admin/library-warm) as background jobs — the guardrail-37a
// pattern. A full walk of a large library, or a cold warm of one, runs for
// minutes while a reverse proxy holds a request for ~60 s (nginx, NPM) to
// ~100 s (Cloudflare): held open, the browser read a proxy 502 as a failure
// while the run finished on the server.
//
// `{ async: true }` from an admin answers 202 { job } at once; the run's own
// answer (status + body, exactly what the synchronous route sends) is read
// with GET ?job=. The synchronous default is unchanged for every other caller
// (cron, the iOS app). Jobs live in the shared in-process registry
// (release-search-jobs.ts): a restart drops them and the poll 404s.
import { NextResponse } from "next/server";
import type { Translator } from "@/lib/i18n/translate";
import { jobResponse, startArrJob } from "@/lib/release-search-jobs";
import { getSyncableMediaInstances } from "@/lib/media-instance-registry";
import type { LibrarySyncServer } from "@/lib/client/library-sync";

/**
 * Every configured Plex and Jellyfin server — default and named, in registry
 * order — for the Re-sync and Initial DB Fill buttons, which skip anything
 * else before a request (guardrail 36).
 */
export async function configuredLibrarySyncServers(): Promise<LibrarySyncServer[]> {
  const [plex, jellyfin] = await Promise.all([getSyncableMediaInstances("plex"), getSyncableMediaInstances("jellyfin")]);
  return [
    ...plex.map((i) => ({ service: "plex" as const, slug: i.slug, name: i.name })),
    ...jellyfin.map((i) => ({ service: "jellyfin" as const, slug: i.slug, name: i.name })),
  ];
}

/** Whether a parsed body asks for a background run. */
export function wantsBackgroundRun(body: unknown): boolean {
  return !!body && typeof body === "object" && !Array.isArray(body) && (body as { async?: unknown }).async === true;
}

/**
 * Start `run` as `owner`'s job under `key` — or join the owner's job already
 * running for that key — and answer 202 { job }. The registry is shared, so
 * every key here is prefixed.
 */
export function startLibraryJob(owner: string, key: string, run: () => Promise<Response>): NextResponse {
  const { jobId } = startArrJob(owner, `library-job\u0000${key}`, async () => {
    const res = await run();
    return { status: res.status, body: await res.json().catch(() => null) };
  });
  return NextResponse.json({ job: jobId }, { status: 202 });
}

/** The poll answer: 202 while the job runs, then the run's own answer; 404 once it is gone. */
export function libraryJobResponse(owner: string, jobId: string, t: Translator): NextResponse {
  return jobResponse(owner, jobId, t, "apiAdmin.sync.jobGone");
}
