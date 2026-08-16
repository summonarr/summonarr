import * as client from "openid-client";
import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { safeFetchAdminConfigured } from "@/lib/safe-fetch";

// Summonarr-native OIDC client — the sole OIDC path (the parallel next-auth
// provider it replaced has been removed). Configured by the OIDC_* env vars,
// targeting a single IdP.
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

// Cookie Path for the OIDC state cookie. MUST include BASE_PATH: on a subpath
// deployment the callback lives at `${BASE_PATH}/api/auth/oidc/callback`, and a
// cookie scoped to the bare "/api/auth/oidc" is never sent back to it — the
// callback then reads no state and every OIDC sign-in fails. Shared by the
// set (oidc/start) and clear (oidc/callback) sites so the two can never drift;
// a mismatched Path silently fails to expire the cookie. No-op when unset.
export const OIDC_STATE_COOKIE_PATH = `${process.env.BASE_PATH ?? ""}/api/auth/oidc`;
const OIDC_STATE_TTL_SECONDS = 5 * 60;

export function isOidcConfigured(): boolean {
  return !!(
    process.env.OIDC_ISSUER &&
    process.env.OIDC_CLIENT_ID &&
    process.env.OIDC_CLIENT_SECRET
  );
}

let configPromise: Promise<client.Configuration> | null = null;

// safeFetchAdminConfigured matches openid-client's CustomFetch signature
// (url: string, options) => Promise<Response>. SafeFetchOptions accepts the
// same RequestInit superset, so passing the options straight through works.
const oidcCustomFetch: client.CustomFetch = (url, options) =>
  safeFetchAdminConfigured(url, options as Parameters<typeof safeFetchAdminConfigured>[1]);

// Discovery is cached process-wide. If the IdP changes its metadata the
// process needs to restart — this matches next-auth's behaviour and the
// realistic ops shape (env-var-driven config + container restart).
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
      // Reset so a later attempt can re-discover after a transient failure
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
  opts?: { native?: boolean },
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
    scope: "openid profile email",
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
): Promise<OidcClaims> {
  const url = new URL(flowState.redirectUri);
  url.searchParams.set("code", code);
  url.searchParams.set("state", state);
  return exchangeOidcCode(url, flowState);
}

export async function exchangeOidcCode(
  requestUrl: URL,
  flowState: OidcFlowState,
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
  // Pull email/profile from claims directly. If the IdP only releases them via
  // userinfo, we could fetchUserInfo here — but most providers (Authelia,
  // Keycloak, Google, Authentik) include them in id_token when the openid+email+profile
  // scope is requested, which matches next-auth's default behaviour.
  return {
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
  };
}
