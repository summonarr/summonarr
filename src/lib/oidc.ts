import * as client from "openid-client";
import { SignJWT, jwtVerify, type JWTPayload } from "jose";

// Summonarr-native OIDC client. Runs in parallel with next-auth's OIDC
// provider during the migration window — both can be enabled by the same
// OIDC_* env vars and target the same IdP. PR 5 retires the next-auth path.
//
// State management: PKCE codeVerifier + state + nonce live in a short-lived
// (5 min) signed JWT cookie between the /start and /callback requests, so
// the server stays stateless. The cookie is httpOnly+SameSite=Lax+Secure
// in production.

export const OIDC_STATE_COOKIE = "summonarr-oidc-flow";
const OIDC_STATE_TTL_SECONDS = 5 * 60;

export function isOidcConfigured(): boolean {
  return !!(
    process.env.OIDC_ISSUER &&
    process.env.OIDC_CLIENT_ID &&
    process.env.OIDC_CLIENT_SECRET
  );
}

let configPromise: Promise<client.Configuration> | null = null;

// Discovery is cached process-wide. If the IdP changes its metadata the
// process needs to restart — this matches next-auth's behaviour and the
// realistic ops shape (env-var-driven config + container restart).
function getOidcConfig(): Promise<client.Configuration> {
  if (!configPromise) {
    configPromise = (async () => {
      const issuer = new URL(process.env.OIDC_ISSUER!);
      const clientId = process.env.OIDC_CLIENT_ID!;
      const clientSecret = process.env.OIDC_CLIENT_SECRET!;
      return client.discovery(
        issuer,
        clientId,
        undefined,
        client.ClientSecretPost(clientSecret),
      );
    })().catch((err) => {
      // Reset so a later attempt can re-discover after a transient failure
      configPromise = null;
      throw err;
    });
  }
  return configPromise;
}

interface OidcFlowState {
  state: string;
  nonce: string;
  codeVerifier: string;
  redirectUri: string;
}

const ENCODER = new TextEncoder();

function getSecret(): Uint8Array {
  const secret = process.env.NEXTAUTH_SECRET ?? process.env.AUTH_SECRET;
  if (!secret) throw new Error("[oidc] NEXTAUTH_SECRET (or AUTH_SECRET) must be set");
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
): Promise<OidcAuthorizationStart> {
  const config = await getOidcConfig();
  const codeVerifier = client.randomPKCECodeVerifier();
  const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
  const state = client.randomState();
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
    state: { state, nonce, codeVerifier, redirectUri },
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
