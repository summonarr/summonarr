// Cron/sync route authorization (guardrail 6): getCronActor / isCronAuthorized.
import { NextRequest } from "next/server";
import { readActiveSummonarrSessionFromRequest } from "@/lib/session-server";
import { parseBearerToken } from "@/lib/mobile-auth";
import { machineIpAllowed } from "@/lib/api-auth";
import { safeCompareStrings } from "@/lib/safe-compare";
import {
  configuredTrustedOrigins,
  isTrustedRequestOrigin,
  parseTrustedOriginEntry,
} from "@/lib/trusted-origin";

// Cron/sync routes are excluded from the proxy.ts CSRF guard (cron containers POST
// without an Origin header). The Bearer-token path is unconditional because callers
// hold a strong server-side secret; the admin-session path must enforce its own
// same-origin check, otherwise a malicious site can drive a logged-in admin's
// browser to POST /api/sync via cookie auth. The origin rules are the proxy's own
// (trusted-origin.ts): Origin, else Referer; AUTH_URL + AUTH_TRUSTED_ORIGIN, else
// the request's own origin; no origin at all fails closed.
//
// Re-exported: tests/cron-auth.test.mts (and older imports) read it from here.
export { parseTrustedOriginEntry };

function isSameOriginRequest(request: NextRequest): boolean {
  return isTrustedRequestOrigin(request.headers, configuredTrustedOrigins(), request.nextUrl.origin);
}

// Every cron/sync route funnels through this — accepts an active admin session OR a Bearer CRON_SECRET.
// These routes are in proxy.ts's isPublicPath(), so the proxy does NOT DB-validate the session;
// readActiveSummonarrSessionFromRequest() does (bearer-first then cookie, revocation/cutoff/role-demotion
// honored immediately), not auth() which would trust a revoked admin's JWT until it expires. A wrong
// Bearer is deliberately NOT throttled — see the note in getCronActor below.
export async function isCronAuthorized(request: NextRequest): Promise<boolean> {
  return (await getCronActor(request)) !== null;
}

/** Who is driving a cron/sync route: an admin (session path) or the scheduler (CRON_SECRET). */
export interface CronActor {
  userId: string;
  userName: string;
  trigger: "admin" | "cron";
}

export const CRON_SYSTEM_ACTOR: CronActor = Object.freeze({
  userId: "system",
  userName: "cron",
  trigger: "cron",
}) as CronActor;

// The authorization decision AND the attribution in ONE session read.
//
// Every cron/sync route needs both: isCronAuthorized to gate, then "who was it"
// for the admin-triggered audit row. Each route used to open-code the second
// half as a fresh readActiveSummonarrSessionFromRequest after the gate, so an
// admin "Run now" paid the DB-checked verifyAndRefreshSession twice — and, for a
// bearer (native) admin with a pending sessionId rotation, the FIRST read
// rotated the row and the second saw a dead token, mis-attributing the run to
// "system/cron". Returning the actor from the single read removes both.
//
// null ⇒ unauthorized. A non-null actor with trigger "admin" carries the
// DB-checked claims (revocation/cutoff/role-demotion honored); trigger "cron"
// means the CRON_SECRET bearer matched and there is no session to attribute.
export async function getCronActor(request: NextRequest): Promise<CronActor | null> {
  // Request-aware read: resolves a bearer JWT (native admin) FIRST, then the
  // cookie, so a native admin holding only a bearer token can use the session
  // path. readActiveSummonarrSession() read the cookie only.
  const claims = await readActiveSummonarrSessionFromRequest(request);
  if (claims?.role === "ADMIN") {
    // Transport check: the session read above resolves bearer-FIRST (token =
    // bearer ?? cookie), so when an Authorization bearer is present, the claims
    // came from it — a cookie can never produce claims while a bearer header
    // exists. Bearer/native sessions skip the same-origin gate (guardrail 6b): a
    // cross-origin page cannot attach a custom Authorization header to a
    // credentialed request, so the check defends nothing for that transport —
    // and enforcing it locked native admins (no Origin/Referer header) out of
    // every cron/sync route. The skip is sound only because the read refuses a
    // token bound to the other transport (guardrail 6h): an admin's browser
    // cookie presented as a bearer produced claims here before that, and walked
    // past this gate. There is no User-Agent fingerprint check (guardrail 6h).
    const fromBearer = parseBearerToken(request.headers.get("authorization")) !== null;
    if (!fromBearer && !isSameOriginRequest(request)) return null;
    // A machine session carries a mint-time IP allowlist as a claim; the withAuth/
    // requireAuth guards re-check it on /api/* but this cron/sync path is the machine
    // session's PRIMARY target, so enforce it here too — otherwise a leaked machine
    // JWT could drive the orchestrator from any IP, defeating the allowlist binding.
    // Enforced for BOTH transports (bearer + cookie): unlike the same-origin gate
    // above, the IP allowlist binds the token regardless of how it's presented
    // (parity with api-auth.ts).
    // Absent/empty allowlist ⇒ machineIpAllowed returns true (no restriction).
    if (!machineIpAllowed(claims, request.headers)) return null;
    return { userId: claims.id, userName: claims.name ?? "admin", trigger: "admin" };
  }

  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    // One parser for both transports: RFC 7235 makes the scheme case-insensitive
    // and allows tabs, and parseBearerToken is what the session reader above
    // already accepted — a `bearer <CRON_SECRET>` scheduler must not fail the
    // session branch and then miss a case-sensitive literal here.
    const presented = parseBearerToken(request.headers.get("authorization"));
    if (presented !== null) {
      // Deliberately NO failure throttle here. CRON_SECRET is enforced ≥32 chars
      // at boot and compared timing-safe, so online brute force is infeasible —
      // and any pre-compare throttle must key on getClientIp, which for the
      // internal loopback cron (no XFF, default TRUST_PROXY) resolves to a shared
      // User-Agent bucket: a wrong-secret caller sharing that bucket could then
      // deny the hourly sync and the 5s play-history poller. A valid Bearer must
      // never be deniable by someone else's failures.
      if (safeCompareStrings(presented, cronSecret)) return CRON_SYSTEM_ACTOR;
    }
  }

  return null;
}
