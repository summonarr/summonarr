import { prisma } from "@/lib/prisma";
import type { SummonarrSession } from "@/lib/api-auth";
import { canAutoRequest, effectivePermissions } from "@/lib/permissions";
import { isFeatureEnabled } from "@/lib/features";
import { maintenanceGuard } from "@/lib/maintenance";
import { checkRateLimit, parseRateLimit } from "@/lib/rate-limit";
import { logAudit } from "@/lib/audit";
import { sanitizeForLog } from "@/lib/sanitize";
import {
  createMediaRequest,
  loadRequestContext,
  type CreateMediaRequestFailure,
  type RequestContext,
} from "@/lib/request-create";

// Watchlist auto-request (Overseerr's "Auto-Request"): a title a user adds to
// their watchlist is filed as a request on their behalf. Two sources:
//
//   - "watchlist":      a Summonarr watchlist add (POST /api/watchlist), filed
//                        inline so the add can report the outcome;
//   - "plex-watchlist": the user's plex.tv watchlist, polled by
//                        /api/cron/sync-plex-watchlists (src/lib/plex-watchlist.ts).
//
// Gated three ways: the global feature flag (default OFF), an AUTO_REQUEST*
// permission bit for the media type, and — for the Plex source — the user's own
// profile toggle. Every auto-request goes through createMediaRequest, the same
// chokepoint POST /api/requests uses, so it inherits every gate a manual request
// has (base REQUEST bits, instance access, quota, blacklist, content cap,
// duplicates, auto-approve) and can never do anything the user couldn't do by
// pressing Request themselves.
//
// The AutoRequestLedger records the outcome per (user, title) so the cron never
// re-requests in a loop. The retry rule:
//
//   TERMINAL — never attempted again by the cron:
//     requested             a request was filed. If an admin later DECLINES or
//                           DELETES it, it stays declined/deleted: re-filing it
//                           every poll is exactly the loop the ledger prevents.
//     already-available, already-requested, blacklisted, permanently-declined,
//     rating-cap, invalid-note, invalid-quality-profile
//                           the answer will not change by asking again.
//   RETRYABLE — re-attempted once AUTO_REQUEST_RETRY_AFTER_MS has passed since
//   the last attempt:
//     quota                 the window rolls over; the title is filed when the
//                           user has room again.
//     forbidden, instance-unavailable, discord-link-required
//                           an admin can grant access / the user can link Discord.
//     tmdb-unverified, arr-unreachable, maintenance, rate-limited, error
//                           transient.
//
// A Summonarr watchlist add is an explicit user action, so it is ALWAYS attempted
// regardless of the ledger (re-adding a title is a fresh ask); it records its
// outcome so the cron does not then repeat it.

export const WATCHLIST_AUTO_REQUEST_FEATURE_KEY = "feature.behavior.watchlistAutoRequest";

export type AutoRequestSource = "watchlist" | "plex-watchlist";

export type AutoRequestOutcome =
  | "requested"
  | "already-available"
  | CreateMediaRequestFailure
  | "discord-link-required"
  | "rate-limited"
  | "maintenance"
  | "error";

export const AUTO_REQUEST_RETRY_AFTER_MS = 6 * 60 * 60 * 1000;

const RETRYABLE_OUTCOMES: ReadonlySet<string> = new Set<AutoRequestOutcome>([
  "quota",
  "forbidden",
  "instance-unavailable",
  "discord-link-required",
  "tmdb-unverified",
  "arr-unreachable",
  "maintenance",
  "rate-limited",
  "error",
]);

export function isRetryableAutoRequestOutcome(outcome: string): boolean {
  return RETRYABLE_OUTCOMES.has(outcome);
}

// Should the Plex watchlist cron attempt this title, given its ledger row?
// No row ⇒ never tried ⇒ yes. An unknown outcome string (a row written by a newer
// build) is treated as terminal: never re-request on a guess.
export function shouldAttemptAutoRequest(
  row: { outcome: string; updatedAt: Date } | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!row) return true;
  if (!isRetryableAutoRequestOutcome(row.outcome)) return false;
  return now - row.updatedAt.getTime() >= AUTO_REQUEST_RETRY_AFTER_MS;
}

export const AUTO_REQUEST_NOTES: Record<AutoRequestSource, string> = {
  watchlist: "Auto-requested from watchlist",
  "plex-watchlist": "Auto-requested from Plex watchlist",
};

export interface AutoRequestAttempt {
  outcome: AutoRequestOutcome;
  requestId: string | null;
  // The filed request's status (PENDING / APPROVED / AVAILABLE), when one was filed.
  status: string | null;
  // A short, user-facing explanation (the request chokepoint's own error text
  // for a refusal) — what the web UI toasts.
  message: string;
}

// A session-shaped actor for a user the CRON is acting for. Only the fields the
// request chokepoint reads: id, role, effective permissions, display name.
export function sessionForUser(user: {
  id: string;
  role: string;
  permissions: bigint;
  name: string | null;
  email: string;
}): SummonarrSession {
  return {
    user: {
      id: user.id,
      role: user.role,
      permissions: effectivePermissions(user.role, user.permissions),
      name: user.name,
      email: user.email,
    },
  };
}

// File one title through the request chokepoint and record the outcome in the
// ledger. Never throws: an unexpected failure becomes the "error" outcome, so a
// watchlist add or one cron user can never be broken by it. Callers have already
// checked the feature flag and the AUTO_REQUEST permission.
export async function autoRequestTitle(opts: {
  session: SummonarrSession;
  tmdbId: number;
  mediaType: "MOVIE" | "TV";
  source: AutoRequestSource;
  // Pre-loaded request context (the cron reuses one per user across titles).
  ctx?: RequestContext;
}): Promise<AutoRequestAttempt> {
  const { session, tmdbId, mediaType, source } = opts;
  let attempt: AutoRequestAttempt;
  try {
    attempt = await fileRequest(opts);
  } catch (err) {
    console.error(
      `[auto-request] ${source} request for ${mediaType}:${tmdbId} (user ${session.user.id}) failed: ${sanitizeForLog(err instanceof Error ? err.message : String(err))}`,
    );
    attempt = { outcome: "error", requestId: null, status: null, message: "Couldn't request this automatically" };
  }

  // Outside any transaction and after the request's own commit — a failed ledger
  // write must not undo or fail the request (guardrail 23/26). The cost of losing
  // it is one extra attempt next poll, which the duplicate check answers
  // "already-requested" without filing anything.
  try {
    await prisma.autoRequestLedger.upsert({
      where: { userId_tmdbId_mediaType: { userId: session.user.id, tmdbId, mediaType } },
      create: { userId: session.user.id, tmdbId, mediaType, source, outcome: attempt.outcome, requestId: attempt.requestId },
      update: { source, outcome: attempt.outcome, requestId: attempt.requestId, attempts: { increment: 1 } },
    });
  } catch (err) {
    console.error(
      `[auto-request] ledger write for ${mediaType}:${tmdbId} (user ${session.user.id}) failed: ${sanitizeForLog(err instanceof Error ? err.message : String(err))}`,
    );
  }

  if (attempt.outcome === "requested") {
    void logAudit({
      userId: session.user.id,
      userName: session.user.name ?? session.user.email ?? session.user.id,
      action: "REQUEST_AUTO",
      target: `${mediaType}:${tmdbId}`,
      details: { source, requestId: attempt.requestId, status: attempt.status },
    });
  }
  return attempt;
}

async function fileRequest(opts: {
  session: SummonarrSession;
  tmdbId: number;
  mediaType: "MOVIE" | "TV";
  source: AutoRequestSource;
  ctx?: RequestContext;
}): Promise<AutoRequestAttempt> {
  const { session, tmdbId, mediaType, source } = opts;
  const refused = (outcome: AutoRequestOutcome, message: string): AutoRequestAttempt =>
    ({ outcome, requestId: null, status: null, message });

  // The same pre-body gates POST /api/requests applies, in the same order.
  const maint = await maintenanceGuard(session);
  if (maint) return refused("maintenance", "Requests are paused for maintenance");

  const ctx = opts.ctx ?? (await loadRequestContext(session.user.id));

  // A user-driven add shares the manual request rate limit; the cron is
  // server-driven and bounded per run instead (plex-watchlist.ts).
  if (source === "watchlist") {
    const limit = parseRateLimit(ctx.settings.rateLimitRequests, 20);
    if (!checkRateLimit(`requests:${session.user.id}`, limit, 60 * 1000)) {
      return refused("rate-limited", "Too many requests — try again later");
    }
  }

  if (ctx.settings.discordRequireLinkedAccountSite === "true" && !ctx.userRecord?.discordId) {
    return refused("discord-link-required", "You must link your Discord account before making requests");
  }

  const result = await createMediaRequest(session, ctx, { tmdbId, mediaType, note: AUTO_REQUEST_NOTES[source] });
  if (!result.ok) return refused(result.reason, result.error);
  if (result.kind === "already-available") return refused("already-available", "Already available");
  return {
    outcome: "requested",
    requestId: result.request.id,
    status: result.request.status,
    message: result.request.status === "PENDING" ? "Requested — waiting for approval" : "Requested",
  };
}

// The in-app half: called by POST /api/watchlist after the item is saved. Returns
// null when auto-request does not apply (feature off, or no AUTO_REQUEST bit for
// this media type) — the route then answers exactly as it always has. The
// permission is checked FIRST so a user without it costs no extra query.
export async function maybeAutoRequestWatchlistAdd(
  session: SummonarrSession,
  tmdbId: number,
  mediaType: "MOVIE" | "TV",
): Promise<AutoRequestAttempt | null> {
  if (!canAutoRequest(session.user.permissions, mediaType)) return null;
  let enabled: boolean;
  try {
    enabled = await isFeatureEnabled(WATCHLIST_AUTO_REQUEST_FEATURE_KEY);
  } catch (err) {
    console.error(`[auto-request] feature flag read failed: ${sanitizeForLog(err instanceof Error ? err.message : String(err))}`);
    return null;
  }
  if (!enabled) return null;
  return autoRequestTitle({ session, tmdbId, mediaType, source: "watchlist" });
}
