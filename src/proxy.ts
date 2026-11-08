import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isLocalHost } from "@/lib/local-only";
import {
  markSessionResponseUncacheable,
  parseSessionCookie,
  replaceSessionCookie,
  serializeSessionCookie,
  serializeClearedSessionCookies,
} from "@/lib/session-cookie";
import {
  verifyAndRefreshSession,
  type RefreshedToken,
  type VerifyAndRefreshResult,
} from "@/lib/session-refresh";
import { verifySessionJwt } from "@/lib/session-jwt";
import { parseAuthUrl } from "@/lib/auth-url";
import {
  configuredTrustedOrigins,
  isTrustedOrigin,
  requestOrigin,
} from "@/lib/trusted-origin";
import {
  parseBearerToken,
  hasNativeClientHeader,
  NATIVE_CLIENT_HEADER,
} from "@/lib/mobile-auth";
import {
  API_VERSION,
  parseNativeClient,
  isClientBelowMinimum,
} from "@/lib/api-version";
import { effectivePermissions, parsePermissions } from "@/lib/permissions";
import { isAuthRouteExemptFromCsrf, isMachinePath, isPublicPath } from "@/lib/proxy-paths";
import { proxyAccessDecision } from "@/lib/admin-access";
import { forgetWarnOnChange, warnOnChange } from "@/lib/log-dedup";

const trustProxy = process.env.TRUST_PROXY === "true";

// AUTH_URL + AUTH_TRUSTED_ORIGIN, read once at module load (the rules live in
// trusted-origin.ts, shared with cron-auth.ts and the register route). Empty ⇒
// only a request's own origin is trusted (isTrustedOrigin).
const envOrigins: ReadonlySet<string> = (() => {
  const trusted = configuredTrustedOrigins();
  if (trusted.size === 0 && process.env.NODE_ENV === "production") {
    console.error(
      "[proxy] No trusted origins configured in production. " +
      "Set AUTH_URL to allow browser API calls."
    );
  }
  return trusted;
})();

const MUTATING_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// An app URL for a redirect: AUTH_URL's origin when it parses as an http(s) URL,
// else the request's own origin. A blank (`AUTH_URL=` in a compose file) or
// scheme-less value used to reach `new URL(path, base)` raw and throw, which
// 500'd every logged-out page request outside production (where boot refuses
// such a value). auth-url.ts is zero-import, so proxy.ts stays light.
function appUrl(path: string, req: NextRequest): URL {
  const origin = parseAuthUrl(process.env.AUTH_URL)?.origin ?? req.nextUrl.origin;
  return new URL(`${process.env.BASE_PATH ?? ""}${path}`, origin);
}

function buildLoginRedirect(req: NextRequest): URL {
  const url = appUrl("/login", req);
  // Path AND query: a shared `/movies?genre=28` link must land on the filtered
  // page after sign-in, not on bare `/movies`. The login form validates the
  // value with safeInternalPath, which preserves a query it is given.
  url.searchParams.set("callbackUrl", req.nextUrl.pathname + req.nextUrl.search);
  return url;
}

function loginRedirectResponse(redirectTo: URL, clearCookies: boolean): Response {
  const res = new Response(null, {
    status: 302,
    headers: { Location: redirectTo.toString() },
  });
  if (clearCookies) {
    for (const cookie of serializeClearedSessionCookies()) {
      res.headers.append("Set-Cookie", cookie);
    }
  }
  return res;
}

// ─── Content-Security-Policy ────────────────────────────────────────────────

// connect-src: the app itself, plex.tv (the PIN sign-in polls it from the
// browser) and, with OIDC configured, the IdP's origin. Read once at module load
// like the trusted origins above. An issuer that isn't an http(s) URL is left
// out: OIDC sign-in can't use it either, and the boot sequence says why
// (instrumentation.ts).
const OIDC_ORIGIN = parseAuthUrl(process.env.OIDC_ISSUER)?.origin;

// Every directive after script-src. Only the nonce (and the dev-only
// 'unsafe-eval') varies per request, so the rest is built once.
const CSP_TAIL = [
  // Styles keep 'unsafe-inline'. React server-renders every style={{…}} as a
  // style ATTRIBUTE, which no nonce can cover, and with a nonce in the list
  // browsers ignore 'unsafe-inline' — so a nonce here would strip the inline
  // styles the UI is built on (positioned popovers, progress widths). Scripts,
  // the XSS vector this policy exists for, stay nonce + 'strict-dynamic'.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https://image.tmdb.org https://plex.tv https://assets.plex.tv https://secure.gravatar.com https://i0.wp.com",
  "font-src 'self'",
  `connect-src 'self' https://plex.tv${OIDC_ORIGIN ? ` ${OIDC_ORIGIN}` : ""}`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

// The Content-Security-Policy for one response, around its fresh nonce.
//
// 'unsafe-eval' is `next dev` ONLY. React's development build calls eval() to
// reconstruct server-side error stacks in the browser, and Turbopack's HMR
// runtime evaluates modules the same way; without it every dev page logs
// "eval() is not supported in this environment" and those debugging features
// go dark. Next's CSP guide documents this exact carve-out and states neither
// React nor Next uses eval() in production.
//
// NEVER widen this past `=== "development"`. 'unsafe-eval' turns any string
// that reaches eval()/new Function() into executable script, which is most
// of what the nonce + 'strict-dynamic' policy exists to prevent — and a
// production response is the one an attacker can reach. `next build` sets
// NODE_ENV=production, so this reads false for every shipped deployment.
// NODE_ENV is read on every call; tests/proxy.test.mts pins both directions.
function buildCsp(nonce: string): string {
  const isDev = process.env.NODE_ENV === "development";
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    CSP_TAIL,
  ].join("; ");
}

// ─── the gates, in the order proxy() runs them ──────────────────────────────

// Local-only mode: when TRUST_PROXY is not "true" we cannot read the real
// client IP, so we refuse any request whose Host header is not a
// loopback/private-network (RFC1918) address. This protects a public
// deployment that forgot to set TRUST_PROXY — see src/lib/local-only.ts.
function localOnlyRefusal(request: NextRequest): Response | null {
  if (trustProxy || isLocalHost(request.headers.get("host"))) return null;
  return NextResponse.json(
    {
      error:
        "TRUST_PROXY is not enabled. This server only serves local network requests. " +
        "Set TRUST_PROXY=true when running behind a reverse proxy.",
    },
    { status: 403 },
  );
}

// Force-upgrade kill-switch: a native client that positively identifies a
// build below the per-platform minimum is refused on MUTATING requests with
// 426 Upgrade Required. Reads are never blocked, so the app can still fetch
// GET /api/config/compat and render a graceful "update" screen. Version is
// NEVER an authz input — this gates only an honest, identifiable stale build;
// an unknown/legacy build is allowed through. See src/lib/api-version.ts.
function upgradeRequiredRefusal(isMutatingApi: boolean, clientHeader: string | null): Response | null {
  if (!isMutatingApi || !isClientBelowMinimum(parseNativeClient(clientHeader))) return null;
  return NextResponse.json(
    {
      error:
        "This version of the Summonarr app is no longer supported. Please update to the latest version.",
    },
    { status: 426 },
  );
}

// Whether a MUTATING request needs the CSRF Origin check. Webhook, sync and the
// Origin-less auth routes use their own auth. Bearer/native-client requests are
// exempt: both are custom headers a cross-origin page can't attach to a
// credentialed request (CORS preflight blocks them), so either one means this
// request is not a cookie-riding CSRF vector (see src/lib/mobile-auth.ts). It
// is PRESENCE that counts, never validity — auth still runs after the skip —
// and it also lets a native client POST the sign-in route, which has no Origin.
function needsOriginCheck(
  pathname: string,
  isApi: boolean,
  hasBearer: boolean,
  clientHeader: string | null,
): boolean {
  if (!isApi || isAuthRouteExemptFromCsrf(pathname) || isMachinePath(pathname)) return false;
  return !hasBearer && !hasNativeClientHeader(clientHeader);
}

// The CSRF Origin check for a mutating cookie request to a protected API: the
// 403 to return, or null when the request names a trusted origin (its Origin
// header, else its Referer's). Runs before the session is resolved, so a
// cross-site request never costs a DB read.
function csrfRefusal(request: NextRequest): Response | null {
  const origin = requestOrigin(request.headers);
  if (!origin) {
    return NextResponse.json({ error: "Forbidden — missing origin" }, { status: 403 });
  }
  if (!isTrustedOrigin(origin, envOrigins, request.nextUrl.origin)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return null;
}

type SessionResolution =
  | { status: "anonymous" } // no token, or one the verify refused
  | { status: "verified"; result: VerifyAndRefreshResult }
  // The DB-checked verify threw (database unreachable, pool exhausted): neither
  // a session nor a refusal, so the gate decides per path.
  | { status: "unavailable" };

const SESSION_CHECK_WARNING = "proxy:session-check";

// Resolves the session for the gating + role checks. Public paths are verified
// too, so a signed-in user browsing /login etc. still gets any re-signed cookie
// (e.g. after a role change rotated the session).
//
// The transport is where the token came from, and a token bound to the other
// one is refused (guardrail 6h): a stolen browser cookie can't be replayed as a
// bearer to dodge the cookie-only defences (the CSRF Origin check, rotation on
// a privilege change), and a native token can't be planted in a browser as a
// cookie. Rotation only on the cookie transport: this pass hands a cookie
// client its replacement via Set-Cookie, but a bearer client is never given a
// new token (guardrail 6b), so rotating its session would sign the app out.
async function resolveSession(token: string | null, fromBearer: boolean): Promise<SessionResolution> {
  if (!token) return { status: "anonymous" };
  let result: VerifyAndRefreshResult | null;
  try {
    result = await verifyAndRefreshSession(token, {
      transport: fromBearer ? "bearer" : "cookie",
      allowRotation: !fromBearer,
    });
  } catch (err) {
    // Logged once per outage (guardrail 7b): every request with a token lands
    // here until the database answers again.
    const detail = (err instanceof Error ? err.message : String(err)).split("\n")[0].slice(0, 300);
    warnOnChange(
      SESSION_CHECK_WARNING,
      "failing",
      `[proxy] the session check failed — protected requests answer 503 until it recovers: ${detail}`,
    );
    return { status: "unavailable" };
  }
  // A re-signed token means the DB-checked slow path ran and answered, so the
  // outage (if any) is over. The fast path never touches the DB, so it can't say.
  if (result?.refreshed) forgetWarnOnChange(SESSION_CHECK_WARNING);
  return result ? { status: "verified", result } : { status: "anonymous" };
}

const SESSION_UNAVAILABLE_MESSAGE = "Summonarr can't check your session right now. Try again in a moment.";

// A protected request whose session couldn't be checked. Fails closed without
// signing anyone out: nothing is cleared and nobody is sent to /login, so the
// session works again the moment the database does.
function sessionUnavailableResponse(isApi: boolean): Response {
  const headers = { "Retry-After": "5", "Cache-Control": "no-store" };
  if (isApi) {
    return NextResponse.json({ error: SESSION_UNAVAILABLE_MESSAGE }, { status: 503, headers });
  }
  return new Response(SESSION_UNAVAILABLE_MESSAGE, {
    status: 503,
    headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" },
  });
}

// The answer for a request with no usable session on a protected path.
async function unauthenticatedResponse(
  request: NextRequest,
  isApi: boolean,
  sessionToken: string | null,
  fromBearer: boolean,
): Promise<Response> {
  // API clients (native apps, XHR) need a machine-readable 401, not a 302 to
  // the HTML login page. Browser page navigations still get the redirect.
  if (isApi) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // Clear the cookie only when it is junk (forged, expired, malformed, or bound
  // to the bearer transport). A well-signed cookie that failed the DB check may
  // be the PRE-rotation copy a request carried while a privilege change in
  // another tab or prefetch renamed the session: by the time this answer lands
  // the browser holds the rotated cookie under the same name, and Max-Age=0
  // would delete that one, signing the user out. Left alone, the stale token is
  // refused on every request and overwritten at sign-in.
  const keepCookie =
    !fromBearer && sessionToken !== null && (await verifySessionJwt(sessionToken, "cookie")) !== null;
  return loginRedirectResponse(buildLoginRedirect(request), !keepCookie);
}

// The refusal for a protected path, or null to let it through. No User-Agent
// fingerprint check here any more (guardrail 6h): the client writes that
// header, so an attacker replaying a stolen cookie just sent the victim's
// browser family along with it; all the comparison ever did was sign real
// users out when a browser changed its UA.
async function protectedPathRefusal(
  request: NextRequest,
  isApi: boolean,
  session: SessionResolution,
  sessionToken: string | null,
  fromBearer: boolean,
): Promise<Response | null> {
  if (session.status === "unavailable") return sessionUnavailableResponse(isApi);
  if (session.status === "anonymous") {
    return unauthenticatedResponse(request, isApi, sessionToken, fromBearer);
  }
  // The effective mask (ADMIN role → superbit; unseeded → role preset) for the
  // admin-surface rules in admin-access.ts.
  const { claims } = session.result;
  const perms = effectivePermissions(claims.role, parsePermissions(claims.permissions));
  switch (proxyAccessDecision(request.nextUrl.pathname, claims.role, perms)) {
    case "forbidden":
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    case "redirect-home":
      return NextResponse.redirect(appUrl("/", request));
    case "allow":
      return null;
  }
}

// Hand the refreshed JWT to the DOWNSTREAM verifier in THIS pass. The session
// is verified twice per request (here, then again in authenticateRequest for
// API routes / authActive() for page renders), and both read the token off the
// forwarded request. When this pass ROTATED the sessionId (a role/permission
// change), the incoming credential is already dead — the second pass would find
// no AuthSession row and 401 the route or redirect the page to /login. It also
// carries the `dbCheckedAt` claim this pass just stamped, so the second verify
// takes the fast path instead of repeating the whole DB-checked slow path.
function forwardRefreshedToken(
  requestHeaders: Headers,
  request: NextRequest,
  token: string,
  fromBearer: boolean,
): void {
  if (fromBearer) {
    // Bearer transport: rewrite the FORWARDED Authorization header. This is
    // purely server-internal — the client is handed no replacement (no
    // Set-Cookie, no token in a body) and keeps presenting the token it
    // signed in with, so guardrail 6b's "no refresh for bearer clients" holds.
    // Without this a bearer request paid the full DB-checked verify TWICE:
    // `dbCheckedAt` is only stamped by the re-sign here, so a bearer token
    // that was never rewritten could never take the fast path.
    requestHeaders.set("authorization", `Bearer ${token}`);
  } else {
    requestHeaders.set("cookie", replaceSessionCookie(request.headers.get("cookie"), token));
  }
}

// Send the re-signed JWT back to the browser (a sessionId rotation or a
// dbCheckedAt bump). Cookie sessions only: a bearer client can't read
// Set-Cookie, so it keeps presenting the token it was given at sign-in
// (guardrails 6b/6c).
//
// A response carrying a session token must never be stored: a shared cache
// replaying it would hand this session to the next visitor. Next leaves a
// Cache-Control the proxy set alone (send-payload.js only fills one in when
// none exists), so this also covers page renders, which next.config.ts's
// /api/* header rule doesn't reach.
function returnRefreshedCookie(response: Response, refreshed: RefreshedToken): void {
  response.headers.append(
    "Set-Cookie",
    serializeSessionCookie(refreshed.token, { maxAgeSeconds: refreshed.expiresInSeconds }),
  );
  markSessionResponseUncacheable(response.headers);
}

// Hands the request on to the app, stamped with a fresh CSP nonce, the API
// version and — when this pass re-signed the session — the refreshed token.
function passThrough(
  request: NextRequest,
  verified: VerifyAndRefreshResult | null,
  fromBearer: boolean,
): Response {
  // A fresh random nonce per request. It is passed on in the x-nonce request
  // header, and server components read it to stamp their inline scripts.
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const cspValue = buildCsp(nonce);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", cspValue);
  // Before NextResponse.next(): Next snapshots these headers into
  // x-middleware-request-* at construction time, so mutating afterwards is a
  // no-op.
  const refreshed = verified?.refreshed;
  if (refreshed) forwardRefreshedToken(requestHeaders, request, refreshed.token, fromBearer);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", cspValue);
  // Advertise the API contract version so a native client can passively learn
  // server capability on any response. Authoritative source is the public
  // GET /api/config/compat; this is a coarse integer, never the marketing version.
  response.headers.set("X-Summonarr-Api", String(API_VERSION));
  if (refreshed && !fromBearer) returnRefreshedCookie(response, refreshed);
  return response;
}

export async function proxy(request: NextRequest) {
  const hostRefusal = localOnlyRefusal(request);
  if (hostRefusal) return hostRefusal;

  const { pathname } = request.nextUrl;
  // "Is this the API?" decides restrictions (the 426 gate, the Origin check, a
  // 401 rather than a login redirect), so it folds case like the admin rules in
  // admin-access.ts; the exemptions in proxy-paths.ts match exactly.
  const isApi = pathname.toLowerCase().startsWith("/api/");
  const isMutating = MUTATING_METHODS.has(request.method.toUpperCase());
  // Native/API clients authenticate with `Authorization: Bearer <session-jwt>`
  // and tag requests with X-Summonarr-Client instead of the browser cookie.
  // Presence of the tag drives the CSRF skip; its parsed build drives the 426.
  const bearerToken = parseBearerToken(request.headers.get("authorization"));
  const fromBearer = bearerToken !== null;
  const clientHeader = request.headers.get(NATIVE_CLIENT_HEADER);

  const upgrade = upgradeRequiredRefusal(isMutating && isApi, clientHeader);
  if (upgrade) return upgrade;

  if (isMutating && needsOriginCheck(pathname, isApi, fromBearer, clientHeader)) {
    const refusal = csrfRefusal(request);
    if (refusal) return refusal;
  }

  // Prefer the bearer token (native clients) over the cookie (browsers); the
  // two never coexist for one principal, and resolving the bearer first means a
  // forged cookie can never ride a CSRF-exempt bearer request.
  const sessionToken = bearerToken ?? parseSessionCookie(request.headers.get("cookie"));
  const session = await resolveSession(sessionToken, fromBearer);

  if (!isPublicPath(pathname)) {
    const refusal = await protectedPathRefusal(request, isApi, session, sessionToken, fromBearer);
    if (refusal) return refusal;
  }

  return passThrough(request, session.status === "verified" ? session.result : null, fromBearer);
}

export const config = {
  matcher: [
    // Pages: a router prefetch skips the proxy, as Next's CSP guide recommends —
    // its response needs no CSP, and every (app) page and layout runs its own
    // DB-checked session read for exactly this path (guardrail 29).
    {
      source: "/((?!api(?:/|$)|_next/static|_next/image|favicon.ico|sw\\.js).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
    // The API: every request, whatever its headers. No router prefetch targets
    // /api, and those headers are client-set, so exempting them here let any
    // client skip the Host gate, the 426 gate, the CSRF Origin check and the
    // auth gates — on any method.
    "/api/:path*",
  ],
};
