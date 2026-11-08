// Plex accounts: the plex.tv token and user reads sign-in relies on, the
// owner's servers, the friends list (/api/users), and which accounts may use
// one of THIS deployment's servers — the membership allowlist (guardrail 35:
// the caller unions it across servers and fails open on an indeterminate one).
import { safeFetchTrusted } from "./safe-fetch";
import { check, v } from "./validate";
import { asRecord, looseString } from "./media-server-payload";
import {
  FETCH_TIMEOUT_MS,
  PLEX_IDENTITY_TIMEOUT_MS,
  PLEX_TV_HOSTS,
  plexFetch,
  plexTvJsonHeaders,
  plexTvXmlHeaders,
  plexUrl,
} from "./plex-http";

export interface PlexUser {
  id: string;
  email: string;
  username: string;
  thumb: string;
}

export type PlexTokenState = "valid" | "revoked" | "unknown";

/**
 * What plex.tv says about a token. Only a 401 means plex.tv refused it;
 * a timeout, network failure, 429 or 5xx is no answer at all ("unknown").
 * Never throws.
 */
export async function checkPlexToken(token: string, clientId?: string): Promise<PlexTokenState> {
  try {
    const res = await safeFetchTrusted("https://plex.tv/api/v2/ping", {
      allowedHosts: PLEX_TV_HOSTS,
      headers: plexTvJsonHeaders(token, clientId),
      timeoutMs: 10_000,
    });
    if (res.ok) return "valid";
    return res.status === 401 ? "revoked" : "unknown";
  } catch {
    return "unknown";
  }
}

export async function pingPlexToken(token: string, clientId?: string): Promise<boolean> {
  return (await checkPlexToken(token, clientId)) === "valid";
}

/** The account's servers from plex.tv, as plex.tv reports them (parse with parsePlexResources). */
export async function getPlexResources(token: string): Promise<unknown> {
  const res = await safeFetchTrusted("https://plex.tv/api/v2/resources?includeHttps=1&includeRelay=1", {
    allowedHosts: PLEX_TV_HOSTS,
    headers: plexTvJsonHeaders(token),
    timeoutMs: 15_000,
  });
  if (!res.ok) throw new Error(`Failed to fetch Plex servers: ${res.status}`);
  return res.json();
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const PlexTvUserSchema = v.object({
  id: v.optional(v.unknown()),
  email: looseString(),
  username: looseString(),
  title: looseString(),
  friendlyName: looseString(),
  thumb: looseString(),
});

export async function getPlexUser(token: string, clientId?: string): Promise<PlexUser> {
  const res = await safeFetchTrusted("https://plex.tv/api/v2/user", {
    allowedHosts: PLEX_TV_HOSTS,
    headers: plexTvJsonHeaders(token, clientId),
    timeoutMs: 15_000,
  });
  if (!res.ok) throw new Error(`Failed to fetch Plex user: ${res.status}`);
  const parsed = check(PlexTvUserSchema, await res.json());
  if (!parsed.ok) throw new Error("Plex user response is not an object");
  const data = parsed.value;
  const email = data.email ?? "";
  if (!email || !EMAIL_RE.test(email)) {
    throw new Error("Plex user response missing valid email");
  }
  // Plex /api/v2/user returns id as a number; coerce to string for stable provider-subject binding
  const id = typeof data.id === "string" ? data.id : typeof data.id === "number" ? String(data.id) : "";
  if (!id) {
    throw new Error("Plex user response missing required id");
  }
  return {
    id,
    email,
    username: data.username ?? data.title ?? data.friendlyName ?? "",
    thumb: data.thumb ?? "",
  };
}

export interface PlexAccountInfo {
  id: string;
  name: string;
  email: string;
  thumb: string;
  isAdmin: boolean;
}

export interface PlexAccountsResult {
  accounts: PlexAccountInfo[];
  /** The owner hop (/api/v2/user) succeeded. */
  ownerOk: boolean;
  /** The friends hop (/api/users) succeeded — false on a throw OR a non-2xx. */
  friendsOk: boolean;
}

// ── plex.tv /api/users ───────────────────────────────────────────────────────
// plex.tv/api/users answers XML (the v2 JSON endpoint doesn't expose the full
// friend list). ONE reader for it: each <User> start tag's attributes, entity-
// decoded ("o&apos;brien@x.com" is o'brien@x.com, the address the user signs in
// with), plus the machineIdentifier of every <Server> nested in it — the
// servers shared with that user.

interface PlexTvUser {
  attrs: Map<string, string>;
  serverIds: Set<string>;
}

const XML_NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** XML's five named entities and numeric character references; anything else is left as written. */
function decodeXmlEntities(value: string): string {
  if (!value.includes("&")) return value;
  return value.replace(/&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|amp|lt|gt|quot|apos);/g, (whole, body: string) => {
    if (body[0] !== "#") return XML_NAMED_ENTITIES[body];
    const cp = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    return cp > 0 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff) ? String.fromCodePoint(cp) : whole;
  });
}

// The attributes of the start tag whose name ends at `from`: name="value" or
// name='value' pairs, read until the tag closes — a `>` inside a quoted value
// never ends it. The first of a repeated name wins.
function readStartTagAttrs(xml: string, from: number): Map<string, string> {
  const attrs = new Map<string, string>();
  const re = /\s*([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;
  re.lastIndex = from;
  for (let m = re.exec(xml); m !== null; m = re.exec(xml)) {
    if (!attrs.has(m[1])) attrs.set(m[1], decodeXmlEntities(m[2] ?? m[3] ?? ""));
  }
  return attrs;
}

function parsePlexTvUsers(xml: string): PlexTvUser[] {
  const starts: number[] = [];
  const userTag = /<User\b/g;
  for (let m = userTag.exec(xml); m !== null; m = userTag.exec(xml)) starts.push(m.index);
  const users: PlexTvUser[] = [];
  for (let i = 0; i < starts.length; i++) {
    const block = xml.slice(starts[i], i + 1 < starts.length ? starts[i + 1] : xml.length);
    const serverIds = new Set<string>();
    const serverTag = /<Server\b/g;
    for (let m = serverTag.exec(block); m !== null; m = serverTag.exec(block)) {
      const id = readStartTagAttrs(block, m.index + "<Server".length).get("machineIdentifier");
      if (id) serverIds.add(id);
    }
    users.push({ attrs: readStartTagAttrs(block, "<User".length), serverIds });
  }
  return users;
}

// The plex.tv account id (the same value getPlexUser returns and sign-in pins
// to User.plexUserId; Tautulli parses the same attribute as user_id).
function plexTvUserId(u: PlexTvUser): string | null {
  const id = u.attrs.get("id");
  return id && /^\d{1,20}$/.test(id) ? id : null;
}

// Throws on a network failure; a non-2xx answer is returned as its status.
async function fetchPlexTvUsers(adminToken: string): Promise<{ users: PlexTvUser[] } | { status: number }> {
  const res = await safeFetchTrusted("https://plex.tv/api/users", {
    allowedHosts: PLEX_TV_HOSTS,
    headers: plexTvXmlHeaders(adminToken),
    timeoutMs: 15_000,
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    return { status: res.status };
  }
  return { users: parsePlexTvUsers(await res.text()) };
}

/**
 * Every account the admin token can see, ACCOUNT-WIDE: the owner plus every
 * plex.tv friend, on whichever of the owner's servers they share — no
 * per-server scoping (the one-shot Plex user backfill wants exactly that; a
 * per-server answer is getPlexFriendEmails / countPlexServerMembers). Comes
 * with per-hop status.
 *
 * Both hops are swallowed independently below, so a bare array cannot express
 * "the owner came back but the friends list failed" — that is indistinguishable
 * from "this admin genuinely has no shared users". The one-shot Plex user
 * backfill needs the difference: it stamps a never-retry marker, and stamping it
 * on a half-fetched list strands every user who only appears in the missing half.
 */
export async function getPlexAccountsDetailed(adminToken: string): Promise<PlexAccountsResult> {
  const accounts: PlexAccountInfo[] = [];
  let ownerOk = false;
  let friendsOk = false;

  try {
    // The server owner doesn't appear in the shared-users list — fetch separately and use the real
    // Plex account id as the provider-subject. A synthetic id would later get bound to User.plexUserId
    // by the backfill and break (provider, sub)-keyed sign-in for the owner.
    const owner = await getPlexUser(adminToken);
    accounts.push({ id: owner.id, name: owner.username, email: owner.email, thumb: owner.thumb, isAdmin: true });
    ownerOk = true;
  } catch (err) {
    console.warn("[plex] Failed to fetch server owner info:", err instanceof Error ? err.message : String(err));
  }

  try {
    const answer = await fetchPlexTvUsers(adminToken);
    // A non-2xx reads as a failed hop (friendsOk false) without a warn here.
    const users = "users" in answer ? answer.users : [];
    friendsOk = "users" in answer;
    for (const u of users) {
      const id = plexTvUserId(u);
      const name = u.attrs.get("title");
      if (!id || !name) continue;
      accounts.push({
        id,
        name,
        email: u.attrs.get("email")?.toLowerCase() ?? "",
        thumb: u.attrs.get("thumb") ?? "",
        isAdmin: false,
      });
    }
  } catch (err) {
    console.warn("[plex] Failed to fetch shared users:", err instanceof Error ? err.message : String(err));
  }

  return { accounts, ownerOk, friendsOk };
}

// Reads the server's machineIdentifier. Swallows every error and returns null —
// callers treat null as "could not reach / could not identify this server".
// timeoutMs defaults to the library-walk timeout for back-compat; pass
// PLEX_IDENTITY_TIMEOUT_MS from any path that iterates instances sequentially.
export async function getPlexMachineId(
  serverUrl: string,
  adminToken: string,
  timeoutMs: number = FETCH_TIMEOUT_MS,
): Promise<string | null> {
  try {
    const res = await plexFetch(plexUrl(serverUrl, "/identity"), adminToken, timeoutMs);
    if (!res.ok) return null;
    const container = asRecord(asRecord(await res.json())?.MediaContainer);
    const id = container?.machineIdentifier;
    return typeof id === "string" && id !== "" ? id : null;
  } catch {
    return null;
  }
}

// Members of THIS server: the plex.tv account ids (immutable, the same
// namespace sign-in binds to User.plexUserId) plus the emails (mutable — a
// user changing their plex.tv email used to fall out of the allowlist and get
// every device revoked mid-session). Consumers match id-first, email-fallback.
export interface PlexServerMembers {
  ids: Set<string>;
  emails: Set<string>;
}

// Connection-test probe: does THIS token actually have ACCESS to THIS server?
// /identity answers without authorization on PMS, so a token valid at plex.tv
// but never shared this server still read "Connected". /library/sections
// requires authorization — 401/403 is the discriminated no-access answer.
export async function checkPlexServerAccess(
  serverUrl: string,
  token: string,
): Promise<"ok" | "unauthorized" | "unreachable"> {
  try {
    const res = await plexFetch(plexUrl(serverUrl, "/library/sections"), token, PLEX_IDENTITY_TIMEOUT_MS);
    if (res.ok) return "ok";
    if (res.status === 401 || res.status === 403) return "unauthorized";
    return "unreachable";
  } catch {
    return "unreachable";
  }
}

export async function getPlexFriendEmails(adminToken: string, serverUrl?: string): Promise<PlexServerMembers> {
  // Defense-in-depth: this set decides who is allowed to sign in via Plex, so it
  // MUST be scoped to friends of *this* server (matched by machineIdentifier
  // below). The caller (auth.ts) already gates on serverUrl, but if a future
  // refactor ever let a missing serverUrl through, the function would otherwise
  // fall back to enumerating every account the admin has friended on ANY Plex
  // server — granting sign-in to people who share no library with this instance,
  // an account-takeover / unauthorized-access hole. Refuse loudly instead of
  // returning an over-broad allowlist.
  if (!serverUrl) {
    console.warn("[plex] getPlexFriendEmails called without serverUrl; refusing to enumerate friends.");
    return { ids: new Set<string>(), emails: new Set<string>() };
  }
  // Short timeout: this runs once per configured instance inside a SEQUENTIAL
  // loop on the Plex sign-in path, and is followed by a 15s plex.tv fetch — at
  // the 60s default a single dead server stalls sign-in for ~75s.
  const machineId = await getPlexMachineId(serverUrl, adminToken, PLEX_IDENTITY_TIMEOUT_MS);
  if (!machineId) {
    console.warn("[plex] getPlexFriendEmails: unable to resolve machineId for server; refusing.");
    return { ids: new Set<string>(), emails: new Set<string>() };
  }

  const answer = await fetchPlexTvUsers(adminToken);
  if (!("users" in answer)) throw new Error(`Failed to fetch Plex users: ${answer.status}`);
  const ids = new Set<string>();
  const emails = new Set<string>();
  for (const u of answer.users) {
    if (!u.serverIds.has(machineId)) continue;
    // Captured even when the email is absent/invalid: the id is the
    // id-first join key.
    const id = plexTvUserId(u);
    if (id) ids.add(id);
    const email = u.attrs.get("email")?.toLowerCase();
    if (email && EMAIL_RE.test(email)) emails.add(email);
  }
  return { ids, emails };
}

/**
 * How many accounts can use THIS server: the owner plus every plex.tv friend
 * it is shared with (the settings page's share count). null when the server
 * can't be identified or plex.tv doesn't answer — never a guess.
 */
export async function countPlexServerMembers(adminToken: string, serverUrl: string): Promise<number | null> {
  const ids = await getPlexServerFriendIds(adminToken, [serverUrl]);
  return ids ? ids.size + 1 : null;
}

/**
 * The plex.tv account ids of the friends any of these servers (all reached with
 * one admin token) is shared with — the owner is not among them. One plex.tv
 * read for every server. null when no server can be identified or plex.tv
 * doesn't answer — never a guess.
 */
export async function getPlexServerFriendIds(adminToken: string, serverUrls: readonly string[]): Promise<Set<string> | null> {
  const machineIds = new Set<string>();
  for (const url of serverUrls) {
    const machineId = await getPlexMachineId(url, adminToken, PLEX_IDENTITY_TIMEOUT_MS);
    if (machineId) machineIds.add(machineId);
  }
  if (machineIds.size === 0) return null;
  try {
    const answer = await fetchPlexTvUsers(adminToken);
    if (!("users" in answer)) return null;
    const ids = new Set<string>();
    for (const u of answer.users) {
      const id = plexTvUserId(u);
      if (id && [...u.serverIds].some((s) => machineIds.has(s))) ids.add(id);
    }
    return ids;
  } catch {
    return null;
  }
}
