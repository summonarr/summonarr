import { NextRequest, NextResponse } from "next/server";
import { initiateJellyfinQuickConnect, pollJellyfinQuickConnect } from "@/lib/jellyfin";
import { getConfiguredJellyfinUrl } from "@/lib/jellyfin-config";
import { DEFAULT_MEDIA_INSTANCE, isValidMediaInstanceSlug } from "@/lib/media-instances";
import { checkRateLimit, getClientIpKey } from "@/lib/rate-limit";
import { hasNativeClientHeader, NATIVE_CLIENT_HEADER } from "@/lib/mobile-auth";
import {
  buildQcFlowSetCookie,
  hashQuickConnectSecret,
  signQcFlowCookie,
} from "@/lib/jellyfin-flow-state";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import type { Translator } from "@/lib/i18n/translate";
import { isSecureCookieContext } from "@/lib/session-cookie";

// `instance` travels as a query param on both the initiate (POST) and poll
// (GET) requests — client-supplied here is fine for BOTH: this only resolves
// which Jellyfin server URL to call, never an authorization decision. The
// security-sensitive step is the sign-in finalize route, which reads the
// instance back out of the signed flow cookie stamped below, never from the
// client. See jellyfin-flow-state.ts.
function readInstanceParam(req: NextRequest): string | null {
  const raw = new URL(req.url).searchParams.get("instance");
  const instance = raw ?? DEFAULT_MEDIA_INSTANCE;
  return isValidMediaInstanceSlug(instance) ? instance : null;
}

// Long-poll can hold the connection up to ~25s, so bump the route timeout above the default
export const maxDuration = 30;

// In-memory per-secret poll counter; caps attempts per QuickConnect session without a DB round-trip
interface PollEntry { count: number; expiresAt: number; }
const pollCounts = new Map<string, PollEntry>();
// Hard ceiling on the poll-count map. Entries are keyed on the CALLER-SUPPLIED
// secret and this endpoint needs no login, so an attacker sending a new secret
// on every request could otherwise grow the map without limit. Expired entries
// are swept first, so the ceiling doesn't reject real sessions — a genuine
// QuickConnect flow holds at most a handful of live keys.
const MAX_POLL_KEYS = 10_000;
function sweepExpiredPollCounts(now: number): void {
  for (const [k, v] of pollCounts) {
    if (v.expiresAt < now) pollCounts.delete(k);
  }
}
const MAX_POLLS = 60;
const QC_TTL = 15 * 60 * 1000;

// Server-side long-poll bounds: total wait per request and per-iteration sleep
const LONG_POLL_MAX_MS = 25_000;
const LONG_POLL_TICK_MS = 2_000;

// Cap concurrent in-flight long-polls per IP. Each long-poll parks the connection
// up to 25s, so without a cap a single attacker (or NAT'd pool) can hold every
// available socket — the per-IP rate limit only protects against burst rates,
// not concurrency. Pattern mirrors src/lib/sse-emitter.ts / /api/events.
const LONG_POLL_PER_IP_CAP = 3;
const LONG_POLL_GLOBAL_CAP = 50;
const inflightByIp = new Map<string, number>();
let globalInflight = 0;

setInterval(() => sweepExpiredPollCounts(Date.now()), 60_000).unref();

// The upstream status a Jellyfin helper attached to its error, or undefined.
// Never cast: a thrown non-object (null, a string) must reach the generic 502,
// not a TypeError that turns into a 500.
function errorStatus(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const status = (err as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

// Machine-readable marker on the terminal "QuickConnect is disabled" 502, so a
// client stops polling instead of retrying into the per-secret rate limit.
// Additive: the status and `error` text are unchanged for native clients.
const QUICKCONNECT_DISABLED_CODE = "quickconnect_disabled";

export async function POST(req: NextRequest) {
  const t = translatorForRequest(req);
  const instance = readInstanceParam(req);
  if (instance === null) {
    return NextResponse.json({ error: t("apiAuth.common.invalidServer") }, { status: 400 });
  }
  // Rate-limit BEFORE the Setting read: this is an unauthenticated surface, so
  // the limiter must bound anonymous DB load too, not only the outbound Jellyfin
  // call (matches setup-status / machine-session / jellyfin/servers).
  if (!checkRateLimit(`qc-initiate:${getClientIpKey(req.headers)}`, 10, 60_000)) {
    return NextResponse.json({ error: t("apiAuth.common.tooManyRequestsTryLater") }, { status: 429 });
  }
  const jellyfinUrl = await getConfiguredJellyfinUrl(instance);
  if (!jellyfinUrl) {
    return NextResponse.json({ error: t("apiAuth.jellyfin.notConfigured") }, { status: 503 });
  }
  try {
    const result = await initiateJellyfinQuickConnect(jellyfinUrl);
    // Bind the secret to this browser so /api/auth/sign-in/jellyfin-quickconnect
    // can refuse a redemption from any other origin. Cookie carries the SHA-256
    // of the secret (not the secret itself) plus the instance the secret was
    // actually issued against — the finalize route trusts THIS, not any
    // instance value a client submits directly.
    const cookieValue = await signQcFlowCookie({
      secretHash: hashQuickConnectSecret(result.secret),
      instance,
    });
    // Native clients can't carry the HttpOnly flow cookie, so hand them the same
    // signed flowState in the body to send back at sign-in (mirrors Plex /start).
    const isNative = hasNativeClientHeader(req.headers.get(NATIVE_CLIENT_HEADER));
    const response = NextResponse.json(isNative ? { ...result, flowState: cookieValue } : result);
    response.headers.append(
      "Set-Cookie",
      buildQcFlowSetCookie(cookieValue, isSecureCookieContext()),
    );
    return response;
  } catch (err) {
    console.error("[jellyfin quickconnect] initiate error:", err);
    // 401 from /QuickConnect/Initiate is Jellyfin's "the feature is disabled"
    // answer — surface it as such instead of the generic reachability message.
    if (errorStatus(err) === 401) {
      return NextResponse.json(
        { error: t("apiAuth.quickConnect.disabled"), code: QUICKCONNECT_DISABLED_CODE },
        { status: 502 },
      );
    }
    return NextResponse.json({ error: t("apiAuth.quickConnect.initiateFailed") }, { status: 502 });
  }
}

export async function GET(req: NextRequest) {
  const t = translatorForRequest(req);
  const instance = readInstanceParam(req);
  if (instance === null) {
    return NextResponse.json({ error: t("apiAuth.common.invalidServer") }, { status: 400 });
  }
  const { searchParams } = new URL(req.url);
  const secret = searchParams.get("secret");
  if (!secret) {
    return NextResponse.json({ error: t("apiAuth.quickConnect.missingSecret") }, { status: 400 });
  }

  // Both limiters run BEFORE the Setting read (same reason as POST above): an
  // anonymous poller must not get a DB round-trip per request past its budget.
  if (!checkRateLimit(`qc-poll:${getClientIpKey(req.headers)}`, 60, 60_000)) {
    return NextResponse.json({ error: t("apiAuth.common.tooManyRequestsTryLater") }, { status: 429 });
  }

  if (!checkRateLimit(`qc-poll-secret:${secret.slice(0, 32)}`, 30, 60_000)) {
    return NextResponse.json({ error: t("apiAuth.common.tooManyRequestsTryLater") }, { status: 429 });
  }

  const jellyfinUrl = await getConfiguredJellyfinUrl(instance);
  if (!jellyfinUrl) {
    return NextResponse.json({ error: t("apiAuth.jellyfin.notConfigured") }, { status: 503 });
  }
  const wait = searchParams.get("wait") === "1";

  const countKey = secret.slice(0, 32);
  const now = Date.now();
  const budget = pollBudget(countKey, now);
  if (budget.kind === "spent") {
    return NextResponse.json({ error: t("apiAuth.quickConnect.sessionExpired") }, { status: 410 });
  }
  if (budget.kind === "full") {
    // Shed load rather than grow unbounded. 503 (not 410) so a legitimate client
    // retries instead of treating its session as dead; `retry: true` (additive)
    // tells it this 503 is temporary, unlike "not configured".
    return NextResponse.json({ error: t("apiAuth.quickConnect.busy"), retry: true }, { status: 503 });
  }
  // Concurrent-long-poll cap (per-IP + global). Reject 503 if exceeded so the
  // client can fall back to short-polling instead of stalling. Checked BEFORE
  // the attempt is charged below: a 503 here means Jellyfin was never asked, and
  // charging a MAX_POLLS attempt anyway let a few tabs behind one NAT address
  // (per-IP cap 3) walk a legitimate secret to the 410 "session expired" state
  // on retries. Nothing awaits between this check and the slot taken in
  // longPoll, so the check/take pair stays race-free.
  const ipKey = getClientIpKey(req.headers);
  if (wait) {
    if (globalInflight >= LONG_POLL_GLOBAL_CAP) {
      return NextResponse.json({ error: t("apiAuth.quickConnect.serverBusy"), retry: true }, { status: 503 });
    }
    if ((inflightByIp.get(ipKey) ?? 0) >= LONG_POLL_PER_IP_CAP) {
      return NextResponse.json({ error: t("apiAuth.quickConnect.tooManyPolls"), retry: true }, { status: 503 });
    }
  }

  pollCounts.set(countKey, { count: budget.attempts, expiresAt: budget.expiresAt });

  try {
    if (!wait) {
      const authenticated = await pollJellyfinQuickConnect(jellyfinUrl, secret, { signal: req.signal });
      if (authenticated) pollCounts.delete(countKey);
      return NextResponse.json({ authenticated });
    }
    return await longPoll(
      req.signal,
      ipKey,
      () => pollJellyfinQuickConnect(jellyfinUrl, secret, { signal: req.signal }),
      countKey,
    );
  } catch (err) {
    // The client left while Jellyfin was being asked: the aborted request is
    // not a Jellyfin failure, and nobody reads the answer.
    if (req.signal.aborted) return NextResponse.json({ authenticated: false }, { status: 499 });
    return pollFailure(err, countKey, t);
  }
}

type PollBudget =
  | { kind: "ok"; attempts: number; expiresAt: number }
  | { kind: "spent" }
  | { kind: "full" };

// This poll's charge against the secret's MAX_POLLS. Not recorded here: the
// caller records it once the request is going to reach Jellyfin.
function pollBudget(countKey: string, now: number): PollBudget {
  const existingRaw = pollCounts.get(countKey);
  // Treat an expired entry as absent so a fresh TTL window starts. Otherwise the
  // new entry inherits the stale (already-past) expiresAt, the count resets to 1
  // on every poll, and MAX_POLLS is never enforced after the first TTL expiry.
  const existing = existingRaw && existingRaw.expiresAt >= now ? existingRaw : undefined;
  if (existingRaw && !existing) pollCounts.delete(countKey);
  const attempts = (existing ? existing.count : 0) + 1;
  const expiresAt = existing?.expiresAt ?? now + QC_TTL;
  if (attempts > MAX_POLLS) {
    // Keep the entry rather than dropping it: deleting the counter here would let
    // the very next poll for the same secret start a fresh 60-attempt window.
    // The 60s sweep above reclaims the key once its TTL passes.
    pollCounts.set(countKey, { count: attempts, expiresAt });
    return { kind: "spent" };
  }
  if (!existing && pollCounts.size >= MAX_POLL_KEYS) {
    sweepExpiredPollCounts(now);
    if (pollCounts.size >= MAX_POLL_KEYS) return { kind: "full" };
  }
  return { kind: "ok", attempts, expiresAt };
}

// Keep asking Jellyfin until the user approves, the client disconnects, or the
// budget elapses. One inbound long-poll counts as one attempt against
// MAX_POLLS regardless of internal ticks. Holds one per-IP and one global slot
// for its whole life.
async function longPoll(
  signal: AbortSignal,
  ipKey: string,
  poll: () => Promise<boolean>,
  countKey: string,
): Promise<NextResponse> {
  inflightByIp.set(ipKey, (inflightByIp.get(ipKey) ?? 0) + 1);
  globalInflight += 1;
  const sleeper = abortableSleeper(signal);
  try {
    const deadline = Date.now() + LONG_POLL_MAX_MS;
    while (Date.now() < deadline) {
      if (signal.aborted) return NextResponse.json({ authenticated: false }, { status: 499 });
      const authenticated = await poll();
      if (authenticated) {
        pollCounts.delete(countKey);
        return NextResponse.json({ authenticated: true });
      }
      // A client that left while Jellyfin was being asked: release the slots
      // now rather than after another tick.
      if (signal.aborted) return NextResponse.json({ authenticated: false }, { status: 499 });
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await sleeper.sleep(Math.min(LONG_POLL_TICK_MS, remaining));
    }
    return NextResponse.json({ authenticated: false });
  } finally {
    sleeper.dispose();
    globalInflight = Math.max(0, globalInflight - 1);
    const remaining = (inflightByIp.get(ipKey) ?? 1) - 1;
    if (remaining <= 0) inflightByIp.delete(ipKey);
    else inflightByIp.set(ipKey, remaining);
  }
}

// A sleep the request's abort cuts short. ONE abort listener for the whole
// long-poll, not one per tick: a per-tick listener stays attached when the
// timer (not the abort) wins, so a full poll would pile up ~13 listeners on the
// same signal and trip Node's max-listeners warning.
function abortableSleeper(signal: AbortSignal): { sleep(ms: number): Promise<void>; dispose(): void } {
  let wake: (() => void) | null = null;
  const onAbort = () => wake?.();
  signal.addEventListener("abort", onAbort, { once: true });
  return {
    sleep(ms) {
      return new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          wake = null;
          resolve();
        }, ms);
        wake = () => {
          clearTimeout(timer);
          wake = null;
          resolve();
        };
      });
    },
    dispose() {
      signal.removeEventListener("abort", onAbort);
    },
  };
}

function pollFailure(err: unknown, countKey: string, t: Translator): NextResponse {
  console.error("[jellyfin quickconnect] poll error:", err);
  // Terminal upstream states, distinguished from transient failures so
  // clients stop polling a dead secret: 404 = the secret expired server-side
  // (same 410 semantics as the MAX_POLLS cap), 401 = QuickConnect is
  // disabled on the server.
  const status = errorStatus(err);
  if (status === 404) {
    pollCounts.delete(countKey);
    return NextResponse.json({ error: t("apiAuth.quickConnect.sessionExpired") }, { status: 410 });
  }
  if (status === 401) {
    return NextResponse.json(
      { error: t("apiAuth.quickConnect.disabled"), code: QUICKCONNECT_DISABLED_CODE },
      { status: 502 },
    );
  }
  return NextResponse.json({ error: t("apiAuth.quickConnect.pollFailed") }, { status: 502 });
}
