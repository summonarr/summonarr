import * as client from "openid-client";
import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { safeFetchAdminConfigured } from "@/lib/safe-fetch";
import { readGroupsClaim } from "@/lib/oidc-allowlist";

// Summonarr's OIDC (OpenID Connect) sign-in client. Configured by the OIDC_*
// env vars and talks to a single identity provider (IdP).
//
// State management: PKCE codeVerifier + state + nonce live in a short-lived
// (5 min) signed JWT cookie between the /start and /callback requests, so
// the server stays stateless. The cookie is httpOnly+SameSite=Lax+Secure
// in production.
//
// SSRF: all outbound OIDC traffic (discovery, token, JWKS, userinfo) is
// routed through safeFetchAdminConfigured so a misconfigured OIDC_ISSUER
// that resolves to a link-local / metadata-service IP can't be reached.
// Private IPs (RFC1918) remain allowed because self-hosted IdPs like
// Authelia/Keycloak on the operator's LAN are a common deployment.

export const OIDC_STATE_COOKIE = "summonarr-oidc-flow";
// The name in a secure context (HTTPS AUTH_URL). The `__Host-` prefix makes the
// browser refuse the cookie unless it is Secure, has Path=/ and NO Domain — so
// a sibling subdomain (evil.example.com beside summonarr.example.com) can't set
// or shadow it. Without it, that sibling could plant ITS OWN signed flow cookie
// (from a flow it started) on Path=/api/auth/oidc, then send the victim to the
// callback with its code: the victim's browser is signed in as the attacker
// (login CSRF), and whatever they then request or rate is the attacker's.
export const OIDC_STATE_COOKIE_SECURE = "__Host-summonarr-oidc-flow";

// Cookie Path for the OIDC state cookie in an INSECURE (http dev) context. MUST
// include BASE_PATH: on a subpath deployment the callback lives at
// `${BASE_PATH}/api/auth/oidc/callback`, and a cookie scoped to the bare
// "/api/auth/oidc" is never sent back to it — the callback then reads no state
// and every OIDC sign-in fails. No-op when unset. A secure context uses "/" —
// `__Host-` requires it.
export const OIDC_STATE_COOKIE_PATH = `${process.env.BASE_PATH ?? ""}/api/auth/oidc`;
const OIDC_STATE_TTL_SECONDS = 5 * 60;

// Same rule as session-cookie.ts: an https AUTH_URL is secure, an http one is
// not, and an unset/odd one is secure in production.
function isSecureOidcCookieContext(): boolean {
  const url = process.env.AUTH_URL ?? "";
  if (url.startsWith("https://")) return true;
  if (url.startsWith("http://")) return false;
  return process.env.NODE_ENV === "production";
}

// The flow cookie's name and attributes for this deployment. Shared by the set
// (oidc/start), read and clear (oidc/callback) sites so they can never drift —
// a mismatched name or Path silently fails to read or expire the cookie.
export function oidcStateCookie(): { name: string; path: string; secure: boolean } {
  return isSecureOidcCookieContext()
    ? { name: OIDC_STATE_COOKIE_SECURE, path: "/", secure: true }
    : { name: OIDC_STATE_COOKIE, path: OIDC_STATE_COOKIE_PATH, secure: false };
}

export function serializeOidcStateCookie(value: string): string {
  const { name, path, secure } = oidcStateCookie();
  const attrs = [`${name}=${value}`, `Path=${path}`, "HttpOnly", "SameSite=Lax", `Max-Age=${OIDC_STATE_TTL_SECONDS}`];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

export function clearOidcStateCookie(): string {
  const { name, path, secure } = oidcStateCookie();
  return `${name}=; Path=${path}; Max-Age=0; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

// The flow cookie's value from a Cookie header — ONLY under this deployment's
// name. In a secure context an unprefixed `summonarr-oidc-flow` is exactly what
// a sibling subdomain can plant, so it is never read as a fallback.
export function readOidcStateCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  const { name } = oidcStateCookie();
  for (const piece of cookieHeader.split(/;\s*/)) {
    const eq = piece.indexOf("=");
    if (eq === -1) continue;
    if (piece.slice(0, eq) === name) return piece.slice(eq + 1);
  }
  return null;
}

// openid-client refuses every non-https request unless `allowInsecureRequests`
// is passed, and it is deliberately NOT passed here: TLS to the IdP is the right
// default, LAN or not. So an `http://` OIDC_ISSUER could never complete a
// sign-in — it only made the login page offer a tab whose every click failed.
// Treat it as unconfigured (the tab hides, the routes 503/redirect) and let
// instrumentation.ts say why ONCE at boot. Pure, so the boot check and the three
// OIDC routes share one definition.
export function isOidcIssuerSecure(issuer: string | undefined): boolean {
  if (!issuer) return false;
  try {
    return new URL(issuer).protocol === "https:";
  } catch {
    return false;
  }
}

export function isOidcConfigured(): boolean {
  return (
    !!(process.env.OIDC_ISSUER && process.env.OIDC_CLIENT_ID && process.env.OIDC_CLIENT_SECRET) &&
    isOidcIssuerSecure(process.env.OIDC_ISSUER)
  );
}

let configPromise: Promise<client.Configuration> | null = null;

// safeFetchAdminConfigured matches openid-client's CustomFetch signature
// (url: string, options) => Promise<Response>. SafeFetchOptions accepts the
// same RequestInit superset, so passing the options straight through works.
const oidcCustomFetch: client.CustomFetch = (url, options) =>
  safeFetchAdminConfigured(url, options as Parameters<typeof safeFetchAdminConfigured>[1]);

// Discovery (fetching the IdP's endpoints and keys) is cached for the life of
// the process. If the IdP changes its metadata, restart the app — config comes
// from env vars anyway, so a change already means a restart.
function getOidcConfig(): Promise<client.Configuration> {
  if (!configPromise) {
    configPromise = (async () => {
      const issuer = new URL(process.env.OIDC_ISSUER!);
      const clientId = process.env.OIDC_CLIENT_ID!;
      const clientSecret = process.env.OIDC_CLIENT_SECRET!;
      const config = await client.discovery(
        issuer,
        clientId,
        undefined,
        client.ClientSecretPost(clientSecret),
        { [client.customFetch]: oidcCustomFetch },
      );
      // Belt-and-suspenders: ensure post-discovery requests (token, JWKS,
      // userinfo) also go through the SSRF-guarded fetch.
      config[client.customFetch] = oidcCustomFetch;
      return config;
    })().catch((err) => {
      // Clear the cache so a later attempt can retry after a transient failure.
      configPromise = null;
      throw err;
    });
  }
  return configPromise;
}

// Marker prefixed onto the OIDC `state` for a NATIVE (app) flow.
//
// Why it lives in `state` and not the cookie: /start is called by the app's own
// URLSession, but the IdP redirect lands in the app's web-auth view — a
// different cookie jar entirely — so the callback sees NO flow cookie on a
// native sign-in. `state` is the one value guaranteed to round-trip, so it is
// what tells the callback to hand the code back to the app instead of
// exchanging it and minting a web session.
//
// This is ROUTING information, not a secret and not an authorization. The native
// flow's security is PKCE: the codeVerifier lives only inside the signed
// flowState token held by the app, so an authorization code lifted out of the
// custom-scheme redirect cannot be redeemed without it.
const NATIVE_STATE_PREFIX = "nat.";

export function isNativeOidcState(state: string | null | undefined): state is string {
  return typeof state === "string" && state.startsWith(NATIVE_STATE_PREFIX);
}

// Custom-scheme target the callback bounces a native flow back to. The app
// intercepts it with ASWebAuthenticationSession (which matches on the scheme
// itself, so this never needs registering as a URL type in the app).
//
// A hardcoded constant on purpose: the callback redirects here while holding an
// authorization code, so accepting a client-supplied target would turn this
// route into an open redirect that leaks the code to whoever asked.
export const NATIVE_OIDC_CALLBACK_SCHEME = "summonarr";
export const NATIVE_OIDC_CALLBACK_URL = `${NATIVE_OIDC_CALLBACK_SCHEME}://oidc-callback`;

interface OidcFlowState {
  state: string;
  nonce: string;
  codeVerifier: string;
  redirectUri: string;
  // Optional same-site post-login destination. Must be validated by the
  // caller before being stamped here — the callback route trusts this value.
  returnTo?: string;
}

const ENCODER = new TextEncoder();

function getSecret(): Uint8Array {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error("[oidc] NEXTAUTH_SECRET must be set");
  return ENCODER.encode(secret);
}

export async function signOidcStateCookie(state: OidcFlowState): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ ...state } as JWTPayload)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt(now)
    .setExpirationTime(now + OIDC_STATE_TTL_SECONDS)
    .sign(getSecret());
}

export async function verifyOidcStateCookie(token: string): Promise<OidcFlowState | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret(), {
      algorithms: ["HS256"],
    });
    if (
      typeof payload.state !== "string" ||
      typeof payload.nonce !== "string" ||
      typeof payload.codeVerifier !== "string" ||
      typeof payload.redirectUri !== "string"
    ) {
      return null;
    }
    return {
      state: payload.state,
      nonce: payload.nonce,
      codeVerifier: payload.codeVerifier,
      redirectUri: payload.redirectUri,
      returnTo: typeof payload.returnTo === "string" ? payload.returnTo : undefined,
    };
  } catch {
    return null;
  }
}

export interface OidcAuthorizationStart {
  url: URL;
  state: OidcFlowState;
}

export async function buildOidcAuthorization(
  redirectUri: string,
  returnTo?: string,
  // requestGroupsScope: the allowlist's opt-in extra "groups" scope.
  opts?: { native?: boolean; requestGroupsScope?: boolean },
): Promise<OidcAuthorizationStart> {
  const config = await getOidcConfig();
  const codeVerifier = client.randomPKCECodeVerifier();
  const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
  // The marker only PREFIXES the random state — it never replaces entropy, so a
  // native state is exactly as unguessable as a web one.
  const state = opts?.native
    ? `${NATIVE_STATE_PREFIX}${client.randomState()}`
    : client.randomState();
  const nonce = client.randomNonce();
  const url = client.buildAuthorizationUrl(config, {
    redirect_uri: redirectUri,
    scope: opts?.requestGroupsScope ? "openid profile email groups" : "openid profile email",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
    nonce,
    response_type: "code",
  });
  return {
    url,
    state: { state, nonce, codeVerifier, redirectUri, returnTo },
  };
}

export interface OidcClaims {
  // The ID token's `iss` (openid-client has already checked it against the
  // discovered issuer). A `sub` is unique only within it.
  issuer: string;
  sub: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  preferredUsername: string | null;
  picture: string | null;
  idToken: string;
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: number | null;
  // The allowlist's group claim, when one was asked for (null: the IdP sent
  // none, or none was asked for).
  groups: string[] | null;
}

export interface OidcExchangeOptions {
  // Read this claim as the user's groups — from the ID token, else userinfo.
  groupsClaim?: string;
}

// Native-flow variant. The app posts back the bare (code, state) it caught on
// the custom-scheme redirect, so there is no real request URL to hand
// openid-client — synthesize one from the redirectUri SIGNED INTO the flow
// state. Using the signed copy (never a client-supplied value) is what keeps
// the token request's redirect_uri pinned to the one the authorization was
// issued against.
export async function exchangeNativeOidcCode(
  code: string,
  state: string,
  flowState: OidcFlowState,
  options: OidcExchangeOptions = {},
): Promise<OidcClaims> {
  return exchangeOidcCode(
    buildOidcExchangeUrl(flowState, new URLSearchParams({ code, state })),
    flowState,
    options,
  );
}

// The URL handed to openid-client's authorizationCodeGrant. It sends the token
// request's `redirect_uri` as this URL with its query stripped, so the ORIGIN
// and PATH must be the signed `flowState.redirectUri` the authorization was
// issued against — never the incoming request's URL. In Next 16 `req.url` is
// built from the server's bind address (e.g. http://0.0.0.0:3000 under the
// Docker image's HOSTNAME=0.0.0.0), not the public AUTH_URL, so passing it made
// every web OIDC exchange fail with invalid_grant. Only the IdP's callback
// params (code, state, iss, error, …) are copied over.
export function buildOidcExchangeUrl(
  flowState: OidcFlowState,
  callbackParams: URLSearchParams,
): URL {
  const url = new URL(flowState.redirectUri);
  for (const [key, value] of callbackParams) url.searchParams.set(key, value);
  return url;
}

export async function exchangeOidcCode(
  requestUrl: URL,
  flowState: OidcFlowState,
  options: OidcExchangeOptions = {},
): Promise<OidcClaims> {
  const config = await getOidcConfig();
  const tokens = await client.authorizationCodeGrant(config, requestUrl, {
    expectedState: flowState.state,
    expectedNonce: flowState.nonce,
    pkceCodeVerifier: flowState.codeVerifier,
  });
  const claims = tokens.claims();
  if (!claims) {
    throw new Error("[oidc] ID token missing");
  }
  const sub = typeof claims.sub === "string" ? claims.sub.trim() : "";
  if (!sub) {
    throw new Error("[oidc] ID token missing required `sub` claim");
  }
  const issuer = typeof claims.iss === "string" ? claims.iss : "";
  if (!issuer) {
    throw new Error("[oidc] ID token missing required `iss` claim");
  }
  // Groups: the ID token first, then userinfo (several IdPs release group
  // claims only there). Asked for only when the allowlist has groups.
  let groups: string[] | null = null;
  if (options.groupsClaim) {
    groups = readGroupsClaim(claims as Record<string, unknown>, options.groupsClaim);
    if (groups === null && tokens.access_token) {
      try {
        const info = await client.fetchUserInfo(config, tokens.access_token, sub);
        groups = readGroupsClaim(info as Record<string, unknown>, options.groupsClaim);
      } catch (err) {
        // No groups ⇒ the allowlist refuses: a userinfo failure fails closed.
        console.warn("[oidc] userinfo request for the groups claim failed:", err instanceof Error ? err.message : err);
      }
    }
  }
  // Pull email/profile from claims directly. If the IdP only releases them via
  // userinfo, we could fetchUserInfo here — but most providers (Authelia,
  // Keycloak, Google, Authentik) include them in id_token when the openid+email+profile
  // scope is requested.
  return {
    issuer,
    sub,
    email: typeof claims.email === "string" ? claims.email : null,
    emailVerified: claims.email_verified === true,
    name: typeof claims.name === "string" ? claims.name : null,
    preferredUsername:
      typeof claims.preferred_username === "string" ? claims.preferred_username : null,
    picture: typeof claims.picture === "string" ? claims.picture : null,
    idToken: tokens.id_token ?? "",
    accessToken: tokens.access_token ?? null,
    refreshToken: tokens.refresh_token ?? null,
    expiresAt:
      typeof tokens.expires_in === "number"
        ? Math.floor(Date.now() / 1000) + tokens.expires_in
        : null,
    groups,
  };
}
