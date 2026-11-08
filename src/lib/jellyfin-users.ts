// Jellyfin server users (the download-policy sync and user offboarding read
// this, guardrail 6j), the settings page's user count, and the per-user
// download policy write.
//
// NOTE: there is deliberately no getJellyfinUserEmail. Jellyfin's API exposes
// no user email field on UserDto (no version carries one), so a /Users/{id}
// probe for `Email` always came back empty — the two callers that depended on
// it (Jellyfin sign-in's real-email guard and the notifications route's
// match-the-server check) were removed with it. getJellyfinAllUsers keeps its
// tolerated-absent Email read for the download-policy sync.
import { safeFetchAdminConfigured } from "./safe-fetch";
import { trimServerBase } from "./server-url";
import { v } from "./validate";
import { asRecord, loose, looseString, parseEach } from "./media-server-payload";
import { FETCH_TIMEOUT_MS, jellyfinAdminHeaders } from "./jellyfin-http";

export interface JellyfinUserInfo {
  id: string;
  name: string;
  email?: string;
  isAdmin: boolean;
  // Policy.IsDisabled — the account still exists but can't sign in.
  isDisabled: boolean;
  downloadsEnabled: boolean;
}

// GET /Users, read once for both the user list and the count. Jellyfin 10.9+
// may answer a QueryResult wrapper { Items: [...] } rather than a plain
// array; both are accepted. Any other shape is null — the callers decide what
// an unreadable list means.
async function fetchJellyfinUsersRaw(baseUrl: string, apiKey: string, timeoutMs: number, signal?: AbortSignal): Promise<unknown[] | null> {
  const res = await safeFetchAdminConfigured(`${trimServerBase(baseUrl)}/Users`, {
    headers: jellyfinAdminHeaders(apiKey),
    timeoutMs,
    signal,
  });
  if (!res.ok) throw new Error(`Jellyfin users: ${res.status}`);
  const body: unknown = await res.json();
  if (Array.isArray(body)) return body;
  const items = asRecord(body)?.Items;
  return Array.isArray(items) ? items : null;
}

const JellyfinRawUserSchema = v.object({
  Id: looseString(),
  Name: looseString(),
  Email: looseString(),
  Policy: loose(v.object({
    IsDisabled: loose(v.boolean()),
    IsAdministrator: loose(v.boolean()),
    EnableContentDownloading: loose(v.boolean()),
  })),
});

export async function getJellyfinAllUsers(
  baseUrl: string,
  apiKey: string,
  opts: { signal?: AbortSignal } = {},
): Promise<JellyfinUserInfo[]> {
  const raw = await fetchJellyfinUsersRaw(baseUrl, apiKey, FETCH_TIMEOUT_MS, opts.signal);
  // An unreadable list is a failed fetch, never "no users": the user sync and
  // offboarding (guardrail 6j) read an empty list as the server's answer.
  if (raw === null) throw new Error("Jellyfin users: unexpected response shape");
  if (raw.length === 0) {
    console.warn("[jellyfin] getJellyfinAllUsers returned 0 users — check API key permissions");
  }

  const users: JellyfinUserInfo[] = [];
  for (const u of parseEach(JellyfinRawUserSchema, raw)) {
    if (!u.Id || !u.Name) continue;
    users.push({
      id: u.Id,
      name: u.Name,
      email: u.Email?.includes("@") ? u.Email : undefined,
      isAdmin: u.Policy?.IsAdministrator === true,
      isDisabled: u.Policy?.IsDisabled === true,
      // Treat an absent Policy or absent EnableContentDownloading as enabled
      // (Jellyfin's default). Only false is explicitly disabled.
      downloadsEnabled: u.Policy?.EnableContentDownloading !== false,
    });
  }
  return users;
}

/** How many users the server lists (the settings page's count); 0 for an unreadable list. */
export async function getJellyfinUserCount(baseUrl: string, apiKey: string): Promise<number> {
  return (await fetchJellyfinUsersRaw(baseUrl, apiKey, 10_000))?.length ?? 0;
}

export async function setJellyfinDownloadPolicy(
  baseUrl: string,
  apiKey: string,
  userId: string,
  enabled: boolean,
): Promise<void> {
  const base = trimServerBase(baseUrl);
  const userRes = await safeFetchAdminConfigured(`${base}/Users/${encodeURIComponent(userId)}`, {
    headers: jellyfinAdminHeaders(apiKey),
    timeoutMs: 10_000,
  });
  if (!userRes.ok) throw new Error(`Jellyfin fetch user ${userId}: ${userRes.status}`);

  // POST /Users/{id}/Policy replaces the WHOLE UserPolicy — Jellyfin
  // deserializes the body into a fresh object, so any field absent from the
  // JSON lands on its C# default (false/empty). A missing/empty Policy read
  // (de-elevated key, truncating proxy) must therefore be a hard failure: a
  // one-key body would strip IsAdministrator/EnabledFolders/every other
  // permission from the account. The policy is copied whole (never through a
  // schema that keeps only declared keys) for the same reason.
  const policy = asRecord(asRecord(await userRes.json())?.Policy);
  if (!policy || Object.keys(policy).length === 0) {
    throw new Error(`Jellyfin user ${userId} returned no Policy — refusing to overwrite the full policy with one field`);
  }

  const patchRes = await safeFetchAdminConfigured(`${base}/Users/${encodeURIComponent(userId)}/Policy`, {
    method: "POST",
    headers: jellyfinAdminHeaders(apiKey),
    body: JSON.stringify({ ...policy, EnableContentDownloading: enabled }),
    timeoutMs: 10_000,
  });
  if (!patchRes.ok) throw new Error(`Jellyfin set policy ${userId}: ${patchRes.status}`);
}
