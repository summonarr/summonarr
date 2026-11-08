// Jellyfin sign-in: username + password, and the QuickConnect trio (initiate,
// poll, exchange). Each answer is checked: a 2xx of another shape (a proxy's
// page, an older server) throws rather than minting a half-formed user.
import { safeFetchAdminConfigured } from "./safe-fetch";
import { trimServerBase } from "./server-url";
import { check, v } from "./validate";
import { FETCH_TIMEOUT_MS, jellyfinIdentityHeaders } from "./jellyfin-http";

export interface JellyfinUser {
  id: string;
  name: string;
}

export interface JellyfinQuickConnectResult {
  secret: string;
  code: string;
}

const AuthenticationResult = v.object({
  User: v.object({ Id: v.string(), Name: v.string() }),
});

async function readSignedInUser(res: Response, missing: string): Promise<JellyfinUser> {
  const parsed = check(AuthenticationResult, await res.json());
  if (!parsed.ok) throw new Error(missing);
  return { id: parsed.value.User.Id, name: parsed.value.User.Name };
}

export async function authenticateWithJellyfin(
  baseUrl: string,
  username: string,
  password: string
): Promise<JellyfinUser> {
  const url = trimServerBase(baseUrl);
  const res = await safeFetchAdminConfigured(`${url}/Users/AuthenticateByName`, {
    method: "POST",
    timeoutMs: FETCH_TIMEOUT_MS,
    headers: jellyfinIdentityHeaders(true),
    body: JSON.stringify({ Username: username, Pw: password }),
  });

  if (!res.ok) {
    console.error(`[jellyfin auth] ${res.status} from ${url}/Users/AuthenticateByName`);
    throw Object.assign(new Error(`Jellyfin auth failed: ${res.status}`), { status: res.status });
  }
  return readSignedInUser(res, "Jellyfin auth response missing User.Id or User.Name");
}

const QuickConnectState = v.object({
  Secret: v.optional(v.unknown()),
  Code: v.optional(v.unknown()),
  Authenticated: v.optional(v.unknown()),
});

async function readQuickConnectState(res: Response) {
  const parsed = check(QuickConnectState, await res.json());
  return parsed.ok ? parsed.value : null;
}

export async function initiateJellyfinQuickConnect(baseUrl: string): Promise<JellyfinQuickConnectResult> {
  const url = trimServerBase(baseUrl);
  const res = await safeFetchAdminConfigured(`${url}/QuickConnect/Initiate`, {
    method: "POST",
    timeoutMs: FETCH_TIMEOUT_MS,
    headers: jellyfinIdentityHeaders(true),
  });
  if (!res.ok) throw Object.assign(new Error(`Jellyfin QuickConnect initiate: ${res.status}`), { status: res.status });
  // Checked, like the sibling auth calls: a proxy page or an older server's
  // other shape would otherwise hand the route an undefined secret (the flow
  // cookie's hash throws on it) or the user an undefined code to type. No
  // status on the error, so the route answers its usual initiate failure.
  const data = await readQuickConnectState(res);
  const secret = data?.Secret;
  const code = data?.Code;
  if (typeof secret !== "string" || !secret || typeof code !== "string" || !code) {
    throw new Error("Jellyfin QuickConnect initiate response missing Secret or Code");
  }
  return { secret, code };
}

// `signal` ends the request when the caller goes away (the long-poll passes the
// browser request's own signal); an abort rejects like fetch does.
export async function pollJellyfinQuickConnect(
  baseUrl: string,
  secret: string,
  opts: { signal?: AbortSignal } = {},
): Promise<boolean> {
  const url = trimServerBase(baseUrl);
  const res = await safeFetchAdminConfigured(`${url}/QuickConnect/Connect?Secret=${encodeURIComponent(secret)}`, {
    timeoutMs: FETCH_TIMEOUT_MS,
    headers: jellyfinIdentityHeaders(false),
    signal: opts.signal,
  });
  if (!res.ok) throw Object.assign(new Error(`Jellyfin QuickConnect poll: ${res.status}`), { status: res.status });
  // Only a real `true` is signed in; anything else (a string, a missing field)
  // is "not yet".
  return (await readQuickConnectState(res))?.Authenticated === true;
}

export async function authenticateWithJellyfinQuickConnect(baseUrl: string, secret: string): Promise<JellyfinUser> {
  const url = trimServerBase(baseUrl);
  const res = await safeFetchAdminConfigured(`${url}/Users/AuthenticateWithQuickConnect`, {
    method: "POST",
    timeoutMs: FETCH_TIMEOUT_MS,
    headers: jellyfinIdentityHeaders(true),
    body: JSON.stringify({ Secret: secret }),
  });
  if (!res.ok) throw new Error(`Jellyfin QuickConnect auth: ${res.status}`);
  return readSignedInUser(res, "Jellyfin QuickConnect auth response missing User.Id or User.Name");
}
