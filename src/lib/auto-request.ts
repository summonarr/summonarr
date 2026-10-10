import { prisma } from "@/lib/prisma";
import type { SummonarrSession } from "@/lib/api-auth";
import { AUTO_REQUEST_MASK, Permission, canAutoRequest, effectivePermissions } from "@/lib/permissions";
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
import { instanceDefaultLocale, translatorFor } from "@/lib/i18n/server-locale";
import type { Translator } from "@/lib/i18n/translate";

// Watchlist auto-request (Overseerr's "Auto-Request"): a title a user adds to
// their watchlist is filed as a request on their behalf. Three sources:
//
//   - "watchlist":       a Summonarr watchlist add (POST /api/watchlist, or
//                         /watchlist add in Discord), filed inline so the add can
//                         report the outcome;
//   - "plex-watchlist":  the user's plex.tv watchlist, polled by
//                         /api/cron/sync-plex-watchlists (src/lib/plex-watchlist.ts);
//   - "trakt-watchlist": the user's Trakt watchlist, polled by
//                         /api/cron/sync-trakt (src/lib/trakt-user.ts) — also the
//                         Jellyfin user's route to a watchlist of titles the
//                         library doesn't hold (Jellyfin has no such list).
//
// Gated three ways: the global feature flag (default OFF), an AUTO_REQUEST*
// permission bit for the media type, and — for the Plex and Trakt sources — the
// user's own profile toggle. Every auto-request goes through createMediaRequest, the same
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

export type AutoRequestSource = "watchlist" | "plex-watchlist" | "trakt-watchlist";
// The sources a cron polls (everything but the inline Summonarr add).
export type PolledAutoRequestSource = Exclude<AutoRequestSource, "watchlist">;

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
  "trakt-watchlist": "Auto-requested from Trakt watchlist",
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
  // The language of `message`: the caller's request for a watchlist add; the
  // instance default when omitted (the cron, which never shows it to anyone).
  t?: Translator;
}): Promise<AutoRequestAttempt> {
  const { session, tmdbId, mediaType, source } = opts;
  const t = opts.t ?? translatorFor(instanceDefaultLocale());
  let attempt: AutoRequestAttempt;
  try {
    attempt = await fileRequest({ ...opts, t });
  } catch (err) {
    console.error(
      `[auto-request] ${source} request for ${mediaType}:${tmdbId} (user ${session.user.id}) failed: ${sanitizeForLog(err instanceof Error ? err.message : String(err))}`,
    );
    attempt = { outcome: "error", requestId: null, status: null, message: t("apiUser.autoRequest.failed") };
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
  t: Translator;
}): Promise<AutoRequestAttempt> {
  const { session, tmdbId, mediaType, source, t } = opts;
  const refused = (outcome: AutoRequestOutcome, message: string): AutoRequestAttempt =>
    ({ outcome, requestId: null, status: null, message });

  // The same pre-body gates POST /api/requests applies, in the same order.
  const maint = await maintenanceGuard(session);
  if (maint) return refused("maintenance", t("apiUser.autoRequest.maintenance"));

  const ctx = opts.ctx ?? (await loadRequestContext(session.user.id));

  // A user-driven add shares the manual request rate limit; the crons are
  // server-driven and bounded per run instead (fileAutoRequestTitles).
  if (source === "watchlist") {
    const limit = parseRateLimit(ctx.settings.rateLimitRequests, 20);
    if (!checkRateLimit(`requests:${session.user.id}`, limit, 60 * 1000)) {
      return refused("rate-limited", t("apiUser.common.tooManyRequestsLater"));
    }
  }

  if (ctx.settings.discordRequireLinkedAccountSite === "true" && !ctx.userRecord?.discordId) {
    return refused("discord-link-required", t("apiUser.common.discordLinkRequired"));
  }

  const result = await createMediaRequest(session, ctx, { tmdbId, mediaType, note: AUTO_REQUEST_NOTES[source] }, t);
  if (!result.ok) return refused(result.reason, result.error);
  if (result.kind === "already-available") return refused("already-available", t("apiUser.autoRequest.alreadyAvailable"));
  return {
    outcome: "requested",
    requestId: result.request.id,
    status: result.request.status,
    message: result.request.status === "PENDING" ? t("apiUser.autoRequest.requestedPending") : t("apiUser.autoRequest.requested"),
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
  t?: Translator,
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
  return autoRequestTitle({ session, tmdbId, mediaType, source: "watchlist", t });
}

// ── the polled sources' shared body ─────────────────────────────────────────

// New titles filed per user per run. A first sync of a long watchlist would
// otherwise file hundreds of requests at once; the rest follow on later runs.
export const MAX_AUTO_REQUESTS_PER_USER_PER_RUN = 20;

// A user a cron acts for: the fields sessionForUser needs.
export type AutoRequestCronUser = { id: string; role: string; permissions: bigint; name: string | null; email: string };

// Holds an AUTO_REQUEST* bit (or the ADMIN superbit) on the EFFECTIVE mask —
// what a cron's candidate query cannot express in SQL.
export function hasAutoRequestBit(u: { role: string; permissions: bigint }): boolean {
  const perms = effectivePermissions(u.role, u.permissions);
  return (perms & (AUTO_REQUEST_MASK | Permission.ADMIN)) !== 0n;
}

export interface AutoRequestTally {
  requested: number;
  refused: number;
  // Titles on a list the ledger says not to retry yet (or ever).
  alreadyHandled: number;
  outcomes: Partial<Record<AutoRequestOutcome, number>>;
}

// File one polled list's titles for one user: one entry per title, only the
// media types they may auto-request, only titles the ledger says are due, at
// most MAX_AUTO_REQUESTS_PER_USER_PER_RUN, sequentially. Shared by every polled
// source so the ledger rule, the per-run cap and the dedupe can't drift between
// them (guardrail 34b) — and since the ledger is keyed per (user, title), a
// title on two of a user's lists is filed once whichever cron sees it first.
export async function fileAutoRequestTitles(
  user: AutoRequestCronUser,
  items: ReadonlyArray<{ tmdbId: number | null; mediaType: "MOVIE" | "TV" }>,
  source: PolledAutoRequestSource,
  tally: AutoRequestTally,
  signal: AbortSignal | undefined,
): Promise<void> {
  const session = sessionForUser(user);
  // A list cannot hold duplicates, but a degraded page overlap could.
  const seen = new Set<string>();
  const titles: Array<{ tmdbId: number; mediaType: "MOVIE" | "TV" }> = [];
  for (const item of items) {
    if (item.tmdbId === null) continue;
    if (!canAutoRequest(session.user.permissions, item.mediaType)) continue;
    const key = `${item.mediaType}:${item.tmdbId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    titles.push({ tmdbId: item.tmdbId, mediaType: item.mediaType });
  }
  if (titles.length === 0) return;

  const ledger = await prisma.autoRequestLedger.findMany({
    where: { userId: user.id, tmdbId: { in: [...new Set(titles.map((t) => t.tmdbId))] } },
    select: { tmdbId: true, mediaType: true, outcome: true, updatedAt: true },
  });
  const byKey = new Map(ledger.map((r) => [`${r.mediaType}:${r.tmdbId}`, r]));
  const now = Date.now();
  const due = titles.filter((t) => {
    const attempt = shouldAttemptAutoRequest(byKey.get(`${t.mediaType}:${t.tmdbId}`), now);
    if (!attempt) tally.alreadyHandled++;
    return attempt;
  });
  if (due.length === 0) return;

  // One context read per user, reused across titles (quota/grants/settings).
  const ctx = await loadRequestContext(user.id);
  // Sequential: each filing is several queries and, for an auto-approver, a
  // Radarr/Sonarr push. The per-run cap bounds the first sync of a long list.
  for (const t of due.slice(0, MAX_AUTO_REQUESTS_PER_USER_PER_RUN)) {
    if (signal?.aborted) return; // guardrail 41 — return, never throw
    const attempt = await autoRequestTitle({ session, tmdbId: t.tmdbId, mediaType: t.mediaType, source, ctx });
    tally.outcomes[attempt.outcome] = (tally.outcomes[attempt.outcome] ?? 0) + 1;
    if (attempt.outcome === "requested") tally.requested++;
    else tally.refused++;
  }
}
