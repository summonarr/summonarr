// Client half of the admin's library Resync and Initial DB Fill buttons: one
// full resync per configured Plex/Jellyfin server — every instance, not only
// the default (guardrail 35) — each started as a background job and polled
// until it answers (POST { full, instance, async: true }, then GET ?job= —
// library-sync-jobs.ts, the guardrail-37a pattern).
//
// - Only configured servers are ever in the list: the page decides that before
//   any request (guardrail 36).
// - A service's instances run one after another. The route is single-flight per
//   SERVICE (one advisory lock for every Plex server), so a second Plex resync
//   started beside the first would only answer "already running". Plex and
//   Jellyfin run side by side.
// - "No answer" — the request never answered, a proxy's own 5xx with no JSON
//   body, or the polls ran out — is never a failure: the run may still be going
//   on the server (37a's status-0 convention).
import { runReplaceFileJob } from "./replace-file-job";
import { isGatewayStatus } from "../gateway-status";

export type LibrarySyncService = "plex" | "jellyfin";

/** A configured server, as the page hands it to the buttons. */
export interface LibrarySyncServer {
  service: LibrarySyncService;
  slug: string;
  name: string;
}

export type LibrarySyncOutcome =
  /** The resync finished; `count` items scanned. */
  | { kind: "synced"; count: number }
  /** 200 { skipped }: a resync of this service was already running. */
  | { kind: "running" }
  /** Nothing answered — it may still be running on the server. */
  | { kind: "noAnswer" }
  /** The route's own refusal or failure. */
  | { kind: "failed"; error: string | null; status: number };

type JobAnswer = { status: number; data: unknown };

/** The route's own `error` text in an answer, if it sent one. */
export function jobAnswerError(answer: JobAnswer): string | null {
  const data = answer.data && typeof answer.data === "object" ? (answer.data as Record<string, unknown>) : null;
  return typeof data?.error === "string" && data.error ? data.error : null;
}

/**
 * Whether no answer of the run's own came: none at all (status 0), or a
 * gateway's 502/503/504 standing in for the app with no error of the route's.
 */
export function isNoAnswer(answer: JobAnswer): boolean {
  if (answer.status === 0) return true;
  return jobAnswerError(answer) === null && isGatewayStatus(answer.status);
}

/** A resync's job answer (status 0 = none came) as an outcome. Pure. */
export function librarySyncOutcome(answer: JobAnswer): LibrarySyncOutcome {
  if (isNoAnswer(answer)) return { kind: "noAnswer" };
  const error = jobAnswerError(answer);
  if (answer.status >= 200 && answer.status < 300 && error === null) {
    const data = answer.data as { skipped?: unknown; scanned?: { movies?: unknown; tv?: unknown } } | null;
    if (data?.skipped === true) return { kind: "running" };
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    return { kind: "synced", count: n(data?.scanned?.movies) + n(data?.scanned?.tv) };
  }
  return { kind: "failed", error, status: answer.status };
}

/** The result line's name: the product for the default server (as it always read), "Plex (Name)" for a named one. */
export function librarySyncLabel(server: LibrarySyncServer): string {
  const product = server.service === "plex" ? "Plex" : "Jellyfin";
  return server.slug === "" ? product : `${product} (${server.name})`;
}

export interface LibrarySyncOptions {
  /** The route for a service (withBasePath applied by the caller). */
  url: (service: LibrarySyncService) => string;
  fetchFn?: typeof fetch;
  /** False once the button has unmounted: the polls stop and the run answers null. */
  isAlive?: () => boolean;
  /** Waits between polls; a test passes an immediate one. */
  sleep?: (ms: number) => Promise<void>;
}

const SYNC_POLL_MS = 3_000;
// 400 × 3 s = 20 minutes, past a full walk of a large library; running out is
// "no answer", never a failure.
const SYNC_MAX_POLLS = 400;

/**
 * Resync every server in full. One outcome per server, in the order given;
 * null when `isAlive` turned false before every answer came.
 */
export async function runLibrarySyncs(
  servers: readonly LibrarySyncServer[],
  opts: LibrarySyncOptions,
): Promise<{ server: LibrarySyncServer; outcome: LibrarySyncOutcome }[] | null> {
  const fetchFn = opts.fetchFn ?? fetch;
  const outcomes = new Map<LibrarySyncServer, LibrarySyncOutcome>();
  let gone = false;
  const runService = async (service: LibrarySyncService) => {
    for (const server of servers) {
      if (server.service !== service || gone) continue;
      let outcome: LibrarySyncOutcome;
      try {
        const answer = await runReplaceFileJob(
          fetchFn,
          opts.url(service),
          // The default server sends no slug — the request the route has always had.
          { full: true, ...(server.slug ? { instance: server.slug } : {}) },
          { intervalMs: SYNC_POLL_MS, maxPolls: SYNC_MAX_POLLS, isAlive: opts.isAlive, sleep: opts.sleep },
        );
        if (answer === null) {
          gone = true;
          return;
        }
        outcome = librarySyncOutcome(answer);
      } catch {
        // The start request itself got no answer.
        outcome = { kind: "noAnswer" };
      }
      outcomes.set(server, outcome);
    }
  };
  await Promise.all([runService("plex"), runService("jellyfin")]);
  if (gone) return null;
  return servers.flatMap((server) => {
    const outcome = outcomes.get(server);
    return outcome ? [{ server, outcome }] : [];
  });
}
