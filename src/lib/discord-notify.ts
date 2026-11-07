import { prisma } from "@/lib/prisma";
import { safeFetchTrusted } from "@/lib/safe-fetch";
import { isFeatureEnabled } from "@/lib/features";
import { hasPermission, Permission, effectivePermissions, parsePermissions } from "@/lib/permissions";
import { instanceDefaultLocale, localeForUser, translatorFor } from "@/lib/i18n/server-locale";
import type { Translator } from "@/lib/i18n/translate";
import type { Locale } from "@/lib/i18n/locales";
import { localizedTitleFor, titleResolver, type TitleRef } from "@/lib/tmdb-localize";
import { discordIssueTypeLabelT, mediaLabelT } from "@/lib/notify-i18n";
import { processSingleton } from "@/lib/process-singleton";
import { deriveUserSource, JELLYFIN_SYNTHETIC_EMAIL_SUFFIX, type UserSourceInput } from "@/lib/user-source";

// Language rule: a DM is written in the linked user's language (their stored
// User.locale, else the instance default); anything posted to a SHARED channel
// (the notify channel, the admin channel) is read by everyone there, so it uses
// the instance default (SUMMONARR_DEFAULT_LOCALE, English when unset).
function channelTranslator(): Translator {
  return translatorFor(instanceDefaultLocale());
}

function recipientLocale(viaChannel: boolean, user: { locale?: string | null } | null | undefined): Locale {
  return viaChannel ? instanceDefaultLocale() : localeForUser(user);
}

// BCP 47 tag for date formatting. English keeps the "en-US" it always used
// ("May 1, 2024").
function dateLocaleOf(locale: Locale): string {
  return locale === "en" ? "en-US" : locale;
}

const DISCORD_API = "https://discord.com/api/v10";
const TMDB_POSTER_BASE = "https://image.tmdb.org/t/p/w185";
const DISCORD_FETCH_TIMEOUT_MS = 15_000;
const DISCORD_HOSTS = ["discord.com"];

// Escapes Discord markdown in user/upstream text interpolated into message
// CONTENT (embed titles don't render markdown). Shared with the interactions
// route — every title, query and display name that reaches Discord goes through it.
export function escMd(text: string): string {
  return text.replace(/([*_`~|\\>[\]()@#])/g, "\\$1");
}

function isValidSnowflake(id: string | null | undefined): id is string {
  return typeof id === "string" && /^\d{17,20}$/.test(id);
}

const COLORS = {
  approved:  0x5865F2,
  pending:   0xFEE75C,
  available: 0x57F287,
  declined:  0xED4245,
  issue:     0xEB459E,
} as const;

interface Embed {
  color: number;
  title: string;
  description: string;
  timestamp: string;
}

// Discord rejects the whole message with a 400 (silently dropping the
// notification) when an embed title exceeds 256 chars or a description exceeds
// 4096. User-controlled fields (issue titles, message bodies, admin notes) can
// blow past these, so clamp every embed at the send boundary. Generic so it
// accepts both the strict Embed and the richer Record<string, unknown> embeds
// (with thumbnail/components) built inline elsewhere in this file.
function clampEmbed<T extends { title?: unknown; description?: unknown }>(embed: T): T {
  const clamp = (s: string, max: number): string => {
    if (s.length <= max) return s;
    let cut = s.slice(0, max - 1);
    // Slicing on UTF-16 code units can retain a lone high surrogate whose low
    // surrogate fell past the cut; Discord's strict JSON decoder 400s on that
    // (dropping the notification). Drop the orphaned surrogate.
    const last = cut.charCodeAt(cut.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
    return cut + "…";
  };
  const out: Record<string, unknown> = { ...embed };
  if (typeof embed.title === "string") out.title = clamp(embed.title, 256);
  if (typeof embed.description === "string") out.description = clamp(embed.description, 4096);
  return out as T;
}

// ── Discord rate limits ─────────────────────────────────────────────────────
// Every discord.com call in this module goes through discordRequest. A 429 is
// retried after Discord's own wait (the Retry-After header, else the JSON
// body's retry_after) at most DISCORD_MAX_429_RETRIES times, and a route whose
// bucket reported nothing left (X-RateLimit-Remaining: 0) holds its next call
// until X-RateLimit-Reset-After — so a bulk approve's channel posts are paced
// instead of mostly dropped. All waiting for one call stays under
// DISCORD_MAX_WAIT_MS. The answer is always handed back, never thrown: callers
// keep logging a failure as before.
const DISCORD_MAX_429_RETRIES = 3;
const DISCORD_MAX_WAIT_MS = 15_000;

// Route key → when its bucket refills (epoch ms). Process-wide (guardrail 27a):
// every chunk that posts to Discord shares one bucket view.
const rateHolds = processSingleton("discord-notify:rateHolds", () => new Map<string, number>());

// Discord buckets a route by its MAJOR parameter (the channel or guild id);
// later ids in the path (a member, a role) share that bucket.
function discordRouteKey(method: string, url: string): string {
  let ids = 0;
  const path = new URL(url).pathname.replace(/\d{5,}/g, (id) => (ids++ === 0 ? id : ":id"));
  return `${method} ${path}`;
}

function secondsHeader(res: Response, name: string): number | null {
  const raw = res.headers.get(name);
  if (raw === null || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

async function retryAfterMs(res: Response): Promise<number | null> {
  const header = secondsHeader(res, "retry-after");
  if (header !== null) return Math.ceil(header * 1000);
  try {
    const body = (await res.clone().json()) as { retry_after?: unknown };
    const s = body.retry_after;
    if (typeof s === "number" && Number.isFinite(s) && s >= 0) return Math.ceil(s * 1000);
  } catch {
    // Not JSON — no wait to honour.
  }
  return null;
}

function noteRateLimit(key: string, res: Response): void {
  const remaining = res.headers.get("x-ratelimit-remaining");
  const resetAfter = secondsHeader(res, "x-ratelimit-reset-after");
  if (remaining === "0" && resetAfter !== null) rateHolds.set(key, Date.now() + Math.ceil(resetAfter * 1000));
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function discordRequest(
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
): Promise<Response> {
  const key = discordRouteKey(init.method, url);
  let waited = 0;
  for (let attempt = 0; ; attempt++) {
    const holdUntil = rateHolds.get(key);
    if (holdUntil !== undefined) {
      const hold = holdUntil - Date.now();
      if (hold <= 0) rateHolds.delete(key);
      else {
        const wait = Math.min(hold, DISCORD_MAX_WAIT_MS - waited);
        if (wait > 0) {
          await sleep(wait);
          waited += wait;
        }
      }
    }
    const res = await safeFetchTrusted(url, { ...init, allowedHosts: DISCORD_HOSTS, timeoutMs: DISCORD_FETCH_TIMEOUT_MS });
    noteRateLimit(key, res);
    if (res.status !== 429 || attempt >= DISCORD_MAX_429_RETRIES) return res;
    const wait = await retryAfterMs(res);
    if (wait === null || waited + wait > DISCORD_MAX_WAIT_MS) return res;
    await res.body?.cancel().catch(() => {});
    await sleep(wait);
    waited += wait;
  }
}

async function getConfig(): Promise<{ botToken: string; channelId: string | null } | null> {
  if (!(await isFeatureEnabled("feature.integration.discord"))) return null;
  const rows = await prisma.setting.findMany({
    where: { key: { in: ["discordBotToken", "discordNotifyChannelId"] } },
  });
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  if (!map.discordBotToken) return null;
  return {
    botToken: map.discordBotToken,
    channelId: map.discordNotifyChannelId || null,
  };
}

// What the role sync needs to know about the linked account: its app role
// (admin / issue-admin roles) and how it signs in (the server role).
export type DiscordRoleAccount = UserSourceInput & { role: "ADMIN" | "ISSUE_ADMIN" | "USER" };

// The outcome of one member's role sync: "skipped" when there was nothing to do
// (the integration is off, no guild or no managed role is configured, or the
// member id is not a snowflake), "failed" when any Discord call failed.
export type DiscordRoleSyncOutcome = "ok" | "skipped" | "failed";

// Which media-server role the account earns: the Jellyfin role for a Jellyfin
// identity (subject id, or the synthetic address every Jellyfin account is
// anchored on), the Plex role for a Plex one (subject id, or a legacy Plex row
// deriveUserSource still reads as Plex), and NONE for a local-password or OIDC
// account that signs in through neither server.
export function discordServerRoleSource(u: UserSourceInput): "plex" | "jellyfin" | null {
  if (u.jellyfinUserId != null || u.email.endsWith(JELLYFIN_SYNTHETIC_EMAIL_SUFFIX)) return "jellyfin";
  if (u.plexUserId != null) return "plex";
  return deriveUserSource(u) === "plex" ? "plex" : null;
}

// The role-sync input for one account, read fresh: its role and the sign-in
// facts deriveUserSource uses. Null when the row is gone.
export async function loadDiscordRoleAccount(userId: string): Promise<DiscordRoleAccount | null> {
  const [user, oidc] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, role: true, plexUserId: true, jellyfinUserId: true, passwordHash: true },
    }),
    prisma.account.findFirst({ where: { userId, provider: "oidc" }, select: { id: true } }),
  ]);
  if (!user) return null;
  return {
    email: user.email,
    role: user.role,
    plexUserId: user.plexUserId,
    jellyfinUserId: user.jellyfinUserId,
    hasLocalCredentials: user.passwordHash != null,
    hasOidcAccount: oidc !== null,
  };
}

const ROLE_SETTING_KEYS = ["discordBotToken", "discordGuildId", "discordLinkedRoleId", "discordPlexRoleId", "discordJellyfinRoleId", "discordAdminRoleId", "discordIssueAdminRoleId"];

// The roles Summonarr itself manages (the five configured ids), deduped: the only
// ones the sync ever revokes. A role an operator granted by hand is never in it.
function managedRoleIds(cfg: Record<string, string | undefined>): string[] {
  return [...new Set([
    cfg.discordLinkedRoleId,
    cfg.discordPlexRoleId,
    cfg.discordJellyfinRoleId,
    cfg.discordAdminRoleId,
    cfg.discordIssueAdminRoleId,
  ].filter((id): id is string => isValidSnowflake(id)))];
}

export async function assignDiscordRolesOnLink(discordUserId: string, account: DiscordRoleAccount): Promise<DiscordRoleSyncOutcome> {
  try {
    if (!(await isFeatureEnabled("feature.integration.discord"))) return "skipped";
    const rows = await prisma.setting.findMany({ where: { key: { in: ROLE_SETTING_KEYS } } });
    const cfg = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    if (!cfg.discordBotToken || !cfg.discordGuildId) return "skipped";
    if (!isValidSnowflake(cfg.discordGuildId) || !isValidSnowflake(discordUserId)) return "skipped";

    const source = discordServerRoleSource(account);
    const serverRoleId = source === "jellyfin" ? cfg.discordJellyfinRoleId : source === "plex" ? cfg.discordPlexRoleId : undefined;
    const userRole = account.role;
    const adminRoleId = userRole === "ADMIN" ? cfg.discordAdminRoleId : userRole === "ISSUE_ADMIN" ? cfg.discordIssueAdminRoleId : undefined;

    const roleIds = [cfg.discordLinkedRoleId, serverRoleId, adminRoleId].filter((id): id is string => isValidSnowflake(id));

    // Sync is a DIFF, not an add-only pass. Without the removal half, a user
    // demoted from ADMIN to USER kept their Discord admin role forever — the
    // re-sync re-added the linked/server roles and simply never mentioned the
    // admin one — and a Plex→Jellyfin switch accumulated both server roles.
    //
    // The removal set is deliberately scoped to roles SUMMONARR ITSELF manages
    // (the five configured ids). Anything an operator granted by hand is not in
    // that set and is never touched, so this can only ever revoke a role that
    // Summonarr granted and that the user no longer qualifies for.
    const desired = new Set(roleIds);
    const stale = managedRoleIds(cfg).filter((id) => !desired.has(id));

    if (roleIds.length === 0 && stale.length === 0) return "skipped";

    const memberRoleUrl = (roleId: string) =>
      `${DISCORD_API}/guilds/${cfg.discordGuildId}/members/${discordUserId}/roles/${roleId}`;
    const auth = { Authorization: `Bot ${cfg.discordBotToken}`, "Content-Type": "application/json" };

    const results = await Promise.allSettled([
      ...roleIds.map((roleId) =>
        discordRequest(memberRoleUrl(roleId), { method: "PUT", headers: auth }).then(async (res) => {
          if (!res.ok) {
            const text = await res.text();
            console.error(`[discord-notify] Failed to assign role ${roleId} (${res.status}): ${text}`);
            return false;
          }
          return true;
        })
      ),
      ...stale.map((roleId) =>
        discordRequest(memberRoleUrl(roleId), { method: "DELETE", headers: auth }).then(async (res) => {
          // 404 is the common, benign case: the member never had the role.
          if (!res.ok && res.status !== 404) {
            const text = await res.text();
            console.error(`[discord-notify] Failed to revoke role ${roleId} (${res.status}): ${text}`);
            return false;
          }
          return true;
        })
      ),
    ]);
    return results.every((r) => r.status === "fulfilled" && r.value) ? "ok" : "failed";
  } catch (err) {
    console.error("[discord-notify] assignDiscordRolesOnLink failed:", err);
    return "failed";
  }
}

// The role sync for an account that was just linked, read fresh from its row.
// Never throws: the link has already committed, and losing the Discord side
// must not fail it.
export async function assignDiscordRolesForUser(discordUserId: string, userId: string): Promise<DiscordRoleSyncOutcome> {
  try {
    if (!(await isFeatureEnabled("feature.integration.discord"))) return "skipped";
    const account = await loadDiscordRoleAccount(userId);
    if (!account) return "skipped";
    return await assignDiscordRolesOnLink(discordUserId, account);
  } catch (err) {
    console.error("[discord-notify] assignDiscordRolesForUser failed:", err);
    return "failed";
  }
}

// Revoke every Summonarr-managed role from a member who is no longer linked.
//
// assignDiscordRolesOnLink's diff only runs while an account IS linked, so
// without this an unlinked user kept every role Summonarr ever granted them —
// including the admin role — with no path back short of an operator editing the
// guild by hand. Scoped to the five configured ids for the same reason the sync
// diff is: a role the operator granted independently must never be touched.
//
// Best-effort and self-swallowing (mirrors assignDiscordRolesOnLink): losing the
// Discord side must never fail the unlink itself, which has already committed.
export async function revokeDiscordRolesOnUnlink(discordUserId: string): Promise<DiscordRoleSyncOutcome> {
  try {
    if (!(await isFeatureEnabled("feature.integration.discord"))) return "skipped";
    const rows = await prisma.setting.findMany({ where: { key: { in: ROLE_SETTING_KEYS } } });
    const cfg = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    if (!cfg.discordBotToken || !cfg.discordGuildId) return "skipped";
    if (!isValidSnowflake(cfg.discordGuildId) || !isValidSnowflake(discordUserId)) return "skipped";

    const managed = managedRoleIds(cfg);
    if (managed.length === 0) return "skipped";

    const results = await Promise.allSettled(
      managed.map((roleId) =>
        discordRequest(`${DISCORD_API}/guilds/${cfg.discordGuildId}/members/${discordUserId}/roles/${roleId}`, {
          method: "DELETE",
          headers: { Authorization: `Bot ${cfg.discordBotToken}`, "Content-Type": "application/json" },
        }).then(async (res) => {
          // 404 = the member never had the role (or already left the guild).
          if (!res.ok && res.status !== 404) {
            const text = await res.text();
            console.error(`[discord-notify] Failed to revoke role ${roleId} on unlink (${res.status}): ${text}`);
            return false;
          }
          return true;
        })
      )
    );
    return results.every((r) => r.status === "fulfilled" && r.value) ? "ok" : "failed";
  } catch (err) {
    console.error("[discord-notify] revokeDiscordRolesOnUnlink failed:", err);
    return "failed";
  }
}

export async function notifyAdminsNewRequestDiscord(data: {
  requestId: string;
  title: string;
  mediaType: string;
  tmdbId?: number | null;
  requestedBy: string;
  note: string | null;
  posterPath: string | null;
}): Promise<void> {
  try {
    if (!(await isFeatureEnabled("feature.integration.discord"))) return;
    const rows = await prisma.setting.findMany({
      where: { key: { in: ["discordBotToken", "discordAdminRequestChannelId"] } },
    });
    const cfg = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    if (!cfg.discordBotToken || !cfg.discordAdminRequestChannelId) return;
    if (!isValidSnowflake(cfg.discordAdminRequestChannelId)) return;

    const t = channelTranslator();
    const label = mediaLabelT(t, data.mediaType);
    const localTitle = await localizedTitleFor(data, null); // the channel's language
    const embed: Record<string, unknown> = {
      color: COLORS.pending,
      title: t("notify.discord.newRequest.title", { title: escMd(localTitle) }),
      description: [
        t("notify.discord.newRequest.description", { media: label, user: escMd(data.requestedBy) }),
        // Prefix every line so a multi-line note stays inside the blockquote.
        data.note ? `\n> ${escMd(data.note).replace(/\n/g, "\n> ")}` : "",
      ].filter(Boolean).join(""),
      timestamp: new Date().toISOString(),
    };
    if (data.posterPath) {
      embed.thumbnail = { url: `${TMDB_POSTER_BASE}${data.posterPath}` };
    }

    const components = [{
      type: 1,
      components: [
        { type: 2, style: 3, label: t("notify.discord.newRequest.approve"), custom_id: `admin_approve:${data.requestId}`, emoji: { name: "✅" } },
        { type: 2, style: 4, label: t("notify.discord.newRequest.decline"), custom_id: `admin_decline:${data.requestId}`, emoji: { name: "❌" } },
      ],
    }];

    const res = await discordRequest(`${DISCORD_API}/channels/${cfg.discordAdminRequestChannelId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bot ${cfg.discordBotToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: [clampEmbed(embed)], components, allowed_mentions: { parse: [] } }),
    });
    if (!res.ok) {
      const text = await res.text();
      console.error(`[discord-notify] Failed to post admin request (${res.status}): ${text}`);
    }
  } catch (err) {
    console.error("[discord-notify] notifyAdminsNewRequestDiscord failed:", err);
  }
}

// Posts a new issue to the admin Discord channel (the same channel as new
// requests). Channel-wide, not per-user, so it takes no excludeUserId — mirrors
// notifyAdminsNewRequestDiscord. No approve/decline buttons: issues are triaged
// in-app (claim / resolve / reply), not via embed actions.
export async function notifyAdminsNewIssueDiscord(data: {
  issueId: string;
  title: string;
  mediaType: string;
  tmdbId?: number | null;
  issueType: string;
  reportedBy: string;
  note: string | null;
  posterPath: string | null;
}): Promise<void> {
  try {
    if (!(await isFeatureEnabled("feature.integration.discord"))) return;
    const rows = await prisma.setting.findMany({
      where: { key: { in: ["discordBotToken", "discordAdminRequestChannelId"] } },
    });
    const cfg = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    if (!cfg.discordBotToken || !cfg.discordAdminRequestChannelId) return;
    if (!isValidSnowflake(cfg.discordAdminRequestChannelId)) return;

    const t = channelTranslator();
    const label = mediaLabelT(t, data.mediaType);
    const typeLabel = discordIssueTypeLabelT(t, data.issueType);
    const localTitle = await localizedTitleFor(data, null); // the channel's language
    const embed: Record<string, unknown> = {
      color: COLORS.issue,
      title: t("notify.discord.newIssue.title", { title: escMd(localTitle) }),
      description: [
        t("notify.discord.newIssue.description", { media: label, issue: escMd(typeLabel), user: escMd(data.reportedBy) }),
        // Prefix every line so a multi-line note stays inside the blockquote.
        data.note ? `\n> ${escMd(data.note).replace(/\n/g, "\n> ")}` : "",
      ].filter(Boolean).join(""),
      timestamp: new Date().toISOString(),
    };
    if (data.posterPath) {
      embed.thumbnail = { url: `${TMDB_POSTER_BASE}${data.posterPath}` };
    }

    const res = await discordRequest(`${DISCORD_API}/channels/${cfg.discordAdminRequestChannelId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bot ${cfg.discordBotToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: [clampEmbed(embed)], allowed_mentions: { parse: [] } }),
    });
    if (!res.ok) {
      const text = await res.text();
      console.error(`[discord-notify] Failed to post admin issue (${res.status}): ${text}`);
    }
  } catch (err) {
    console.error("[discord-notify] notifyAdminsNewIssueDiscord failed:", err);
  }
}

async function postToChannel(botToken: string, channelId: string, discordId: string, embed: Embed): Promise<void> {
  if (!isValidSnowflake(channelId) || !isValidSnowflake(discordId)) {
    throw new Error(`Invalid snowflake: channelId=${channelId} discordId=${discordId}`);
  }
  const res = await discordRequest(`${DISCORD_API}/channels/${channelId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bot ${botToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      content: `<@${discordId}>`,
      embeds: [clampEmbed(embed)],
      // parse:[] suppresses @everyone/@here; explicit users array allows the single target mention
      allowed_mentions: { parse: [], users: [discordId] },
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to post to channel (${res.status}): ${text}`);
  }
}

async function chunkSequential(
  tasks: Array<() => Promise<void>>,
  chunkSize: number,
  delayMs: number,
): Promise<void> {
  for (let i = 0; i < tasks.length; i += chunkSize) {
    await Promise.allSettled(tasks.slice(i, i + chunkSize).map((t) => t()));
    if (i + chunkSize < tasks.length) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

// Discord rate-limits opening DM channels, so DMs go out one at a time through
// this queue (600 ms apart) to avoid 429 "too many requests" errors.
const dmQueue: Array<() => Promise<void>> = [];
let dmQueueRunning = false;

function enqueueDm(fn: () => Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    dmQueue.push(async () => {
      try { await fn(); resolve(); } catch (err) { reject(err); }
    });
    if (!dmQueueRunning) processDmQueue();
  });
}

async function processDmQueue(): Promise<void> {
  dmQueueRunning = true;
  while (dmQueue.length > 0) {
    const next = dmQueue.shift()!;
    await next();
    if (dmQueue.length > 0) await new Promise((r) => setTimeout(r, 600));
  }
  dmQueueRunning = false;
}

async function sendDm(botToken: string, discordId: string, embed: Embed): Promise<void> {
  if (!isValidSnowflake(discordId)) {
    throw new Error(`Invalid Discord snowflake for DM: ${discordId}`);
  }
  const dmRes = await discordRequest(`${DISCORD_API}/users/@me/channels`, {
    method: "POST",
    headers: { Authorization: `Bot ${botToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ recipient_id: discordId }),
  });
  if (!dmRes.ok) {
    const text = await dmRes.text();
    throw new Error(`Failed to open DM channel (${dmRes.status}): ${text}`);
  }
  const { id: channelId } = await dmRes.json() as { id: string };
  const msgRes = await discordRequest(`${DISCORD_API}/channels/${channelId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bot ${botToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ embeds: [clampEmbed(embed)] }),
  });
  if (!msgRes.ok) {
    const text = await msgRes.text();
    throw new Error(`Failed to send DM (${msgRes.status}): ${text}`);
  }
}

// `build` renders the embed in the language chosen for this delivery (see
// recipientLocale): the shared notify channel → instance default, a DM → the
// user's own locale.
// `titleRef`: the media title the embed names, resolved in the language the
// embed is written in — the instance default when it goes to the shared
// channel, the user's own language in a DM (guardrail 40a). `build` receives it.
async function notifyUser(
  userId: string,
  // `shared`: the post lands in the shared notification channel every linked user
  // can read, not a DM — a builder carrying private text (a request comment,
  // guardrail 14e; an issue message or resolution) leaves it out there.
  build: (t: Translator, locale: Locale, title: string, shared: boolean) => Embed,
  prefKey?: "notifyOnApproved" | "notifyOnAvailable" | "notifyOnDeclined" | "notifyOnIssue" | "notifyOnComment",
  titleRef?: TitleRef,
): Promise<void> {
  try {
    const cfg = await getConfig();
    if (!cfg) return;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { discordId: true, notifyOnApproved: true, notifyOnAvailable: true, notifyOnDeclined: true, notifyOnIssue: true, notifyOnComment: true, locale: true, deactivatedAt: true },
    });
    if (!user?.discordId) return;
    // Guardrail 33: a disabled account keeps its Discord link. Gated here, the single-user
    // chokepoint, so every notifyUserX sender (issues, download-check) is covered.
    if (user.deactivatedAt) return;
    if (prefKey && user[prefKey] === false) return;

    const locale = recipientLocale(!!cfg.channelId, user);
    const title = titleRef ? (await titleResolver([titleRef], [locale]))(titleRef, locale) : "";
    const embed = build(translatorFor(locale), locale, title, !!cfg.channelId);
    if (cfg.channelId) {
      await postToChannel(cfg.botToken, cfg.channelId, user.discordId, embed);
    } else {
      await enqueueDm(() => sendDm(cfg.botToken, user.discordId!, embed));
    }
  } catch (err) {
    console.error("[discord-notify] Failed to send notification:", err);
  }
}

function approvedEmbed(t: Translator, title: string, mediaType: string): Embed {
  return {
    color: COLORS.approved,
    title: t("notify.discord.approved.title", { title: escMd(title) }),
    description: t("notify.discord.approved.description", { media: mediaLabelT(t, mediaType) }),
    timestamp: new Date().toISOString(),
  };
}

function availableEmbed(t: Translator, title: string, mediaType: string): Embed {
  return {
    color: COLORS.available,
    title: t("notify.discord.available.title", { title: escMd(title) }),
    description: t("notify.discord.available.description", { media: mediaLabelT(t, mediaType) }),
    timestamp: new Date().toISOString(),
  };
}

// `shared`: the post lands in the shared channel, where the admin's note to
// this requester is not everyone's to read — it says a note exists instead.
function declinedEmbed(t: Translator, title: string, mediaType: string, adminNote: string | null | undefined, shared: boolean): Embed {
  const base = t("notify.discord.declined.description", { media: mediaLabelT(t, mediaType) });
  const description = !adminNote
    ? base
    : shared
      ? `${base}\n\n${t("notify.discord.declined.noteShared")}`
      : `${base}\n\n${t("notify.discord.declined.note", { note: escMd(adminNote) })}`;
  return {
    color: COLORS.declined,
    title: t("notify.discord.declined.title", { title: escMd(title) }),
    description,
    timestamp: new Date().toISOString(),
  };
}

export async function notifyUserDownloadPending(userId: string, title: string, mediaType: string, tmdbId?: number | null): Promise<void> {
  await notifyUser(userId, (t, _locale, local) => ({
    color: COLORS.pending,
    title: t("notify.discord.downloadPending.title", { title: escMd(local) }),
    description: t("notify.discord.downloadPending.description", { media: mediaLabelT(t, mediaType) }),
    timestamp: new Date().toISOString(),
  }), "notifyOnApproved", { title, tmdbId, mediaType });
}

export async function notifyUserRequestAvailable(userId: string, title: string, mediaType: string, tmdbId?: number | null): Promise<void> {
  await notifyUser(userId, (t, _locale, local) => availableEmbed(t, local, mediaType), "notifyOnAvailable", { title, tmdbId, mediaType });
}

export async function notifyUserAwaitingRelease(userId: string, title: string, mediaType: string, releaseDate: string | null, tmdbId?: number | null): Promise<void> {
  // Formatted in UTC: TMDB release dates and Sonarr firstAired are DATE values
  // carried as UTC midnight ("2024-05-01" / "…T00:00:00Z"), so the server's local
  // zone (any TZ west of UTC) would name the PREVIOUS day. Same convention as
  // formatReleaseDate (format-release-date.ts).
  const parsed = releaseDate ? new Date(releaseDate) : null;
  await notifyUser(userId, (t, locale, local) => {
    const expected = parsed && !Number.isNaN(parsed.getTime())
      ? ` ${t("notify.discord.awaiting.expected", {
          date: parsed.toLocaleDateString(dateLocaleOf(locale), { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }),
        })}`
      : "";
    return {
      color: COLORS.pending,
      title: t("notify.discord.awaiting.title", { title: escMd(local) }),
      description: t("notify.discord.awaiting.description", { media: mediaLabelT(t, mediaType), expected }),
      timestamp: new Date().toISOString(),
    };
  }, "notifyOnApproved", { title, tmdbId, mediaType });
}

export async function notifyUserIssueMessage(
  userId: string,
  title: string,
  adminName: string,
  body: string,
  media?: { tmdbId?: number | null; mediaType?: string | null },
): Promise<void> {
  // An issue thread is private to the reporter and MANAGE_ISSUES holders: a DM
  // carries the message, a post in the shared channel only pings the reporter.
  await notifyUser(userId, (t, _locale, local, shared) => ({
    color: 0x5865F2,
    title: t("notify.discord.userIssueMessage.title", { title: escMd(local) }),
    description: shared
      ? t("notify.discord.userIssueMessage.descriptionShared", { user: escMd(adminName) })
      : `${t("notify.discord.userIssueMessage.description", { user: escMd(adminName) })}\n\n> ${escMd(body)}`,
    timestamp: new Date().toISOString(),
  }), "notifyOnIssue", { title, ...media });
}

export async function notifyAdminsIssueMessage(
  title: string,
  userName: string,
  // Never posted: this fan-out only reaches the shared channel (see below).
  _body: string,
  opts: { excludeUserId?: string; fromAdmin?: boolean; restrictToUserId?: string; tmdbId?: number | null; mediaType?: string | null } = {},
): Promise<void> {
  try {
    const cfg = await getConfig();
    if (!cfg) return;
    if (!cfg.channelId) return;
    if (!isValidSnowflake(cfg.channelId)) return;

    if (opts.restrictToUserId && opts.restrictToUserId === opts.excludeUserId) return;

    const idFilter = opts.restrictToUserId
      ? { id: opts.restrictToUserId }
      : opts.excludeUserId
        ? { id: { not: opts.excludeUserId } }
        : {};

    const rows = await prisma.user.findMany({
      where: {
        discordId: { not: null },
        notifyOnIssue: true,
        // A disabled account keeps its Discord link (guardrail 33), so without
        // this it would keep getting pinged about every issue message.
        deactivatedAt: null,
        ...idFilter,
      },
      select: { discordId: true, role: true, permissions: true },
    });
    const admins = rows.filter((u) => {
      const perms = effectivePermissions(u.role, parsePermissions(String(u.permissions ?? 0)));
      return hasPermission(perms, Permission.MANAGE_ISSUES);
    });
    if (!admins.length) return;

    // Posted to the shared channel → the instance default language, title included.
    // Every linked user reads that channel, and the thread is private to the
    // reporter and MANAGE_ISSUES holders (a claimed issue narrows even that to
    // the claimer), so the post pings the admins and leaves the message out.
    const t = channelTranslator();
    const localTitle = await localizedTitleFor({ title, tmdbId: opts.tmdbId, mediaType: opts.mediaType }, null);
    const embed: Embed = {
      color: 0xFEE75C,
      title: opts.fromAdmin
        ? t("notify.discord.adminIssueMessage.titleFromAdmin", { title: escMd(localTitle) })
        : t("notify.discord.adminIssueMessage.title", { title: escMd(localTitle) }),
      description: opts.fromAdmin
        ? t("notify.discord.adminIssueMessage.descriptionFromAdmin", { user: escMd(userName) })
        : t("notify.discord.adminIssueMessage.description", { user: escMd(userName) }),
      timestamp: new Date().toISOString(),
    };

    await Promise.allSettled(
      admins.map((a) =>
        postToChannel(cfg.botToken, cfg.channelId!, a.discordId!, embed).catch((err) =>
          console.error("[discord-notify] Failed to notify admin:", err)
        )
      )
    );
  } catch (err) {
    console.error("[discord-notify] Failed to send admin issue message notification:", err);
  }
}

// A manager commented on the requester's request. DM (or the shared channel),
// gated by the requester's own notifyOnComment. The thread is private to the
// requester and request managers (guardrail 14e): a DM carries the text, a post
// in the shared channel only pings them to read it in Summonarr.
export async function notifyUserRequestComment(
  userId: string,
  title: string,
  authorName: string,
  body: string,
  media?: { tmdbId?: number | null; mediaType?: string | null },
): Promise<void> {
  await notifyUser(userId, (t, _locale, local, shared) => ({
    color: 0x5865F2,
    title: t("notify.discord.userRequestComment.title", { title: escMd(local) }),
    description: shared
      ? t("notify.discord.userRequestComment.descriptionShared", { user: escMd(authorName) })
      : `${t("notify.discord.userRequestComment.description", { user: escMd(authorName) })}\n\n> ${escMd(body)}`,
    timestamp: new Date().toISOString(),
  }), "notifyOnComment", { title, ...media });
}

// A requester commented: ping the managers in the ADMIN request channel — the
// same channel as a new-request alert (there is no per-manager DM). Never the
// shared notification channel every linked user reads: the thread is private to
// the requester and request managers (guardrail 14e), and the managers' name for
// the author falls back to the requester's email.
export async function notifyAdminsRequestComment(
  title: string,
  userName: string,
  body: string,
  opts: { excludeUserId?: string; tmdbId?: number | null; mediaType?: string | null } = {},
): Promise<void> {
  try {
    if (!(await isFeatureEnabled("feature.integration.discord"))) return;
    const cfgRows = await prisma.setting.findMany({
      where: { key: { in: ["discordBotToken", "discordAdminRequestChannelId"] } },
    });
    const cfgMap = Object.fromEntries(cfgRows.map((r) => [r.key, r.value]));
    const botToken = cfgMap.discordBotToken;
    const channelId = cfgMap.discordAdminRequestChannelId;
    if (!botToken || !channelId) return;
    if (!isValidSnowflake(channelId)) return;

    const rows = await prisma.user.findMany({
      where: {
        discordId: { not: null },
        notifyOnComment: true,
        deactivatedAt: null, // guardrail 33: a disabled account keeps its Discord link
        ...(opts.excludeUserId ? { id: { not: opts.excludeUserId } } : {}),
      },
      select: { discordId: true, role: true, permissions: true },
    });
    const managers = rows.filter((u) => {
      const perms = effectivePermissions(u.role, parsePermissions(String(u.permissions ?? 0)));
      return hasPermission(perms, Permission.MANAGE_REQUESTS);
    });
    if (!managers.length) return;

    const t = channelTranslator();
    const localTitle = await localizedTitleFor({ title, tmdbId: opts.tmdbId, mediaType: opts.mediaType }, null);
    const embed: Embed = {
      color: 0xFEE75C,
      title: t("notify.discord.adminRequestComment.title", { title: escMd(localTitle) }),
      description: `${t("notify.discord.adminRequestComment.description", { user: escMd(userName) })}\n\n> ${escMd(body)}`,
      timestamp: new Date().toISOString(),
    };

    await Promise.allSettled(
      managers.map((a) =>
        postToChannel(botToken, channelId, a.discordId!, embed).catch((err) =>
          console.error("[discord-notify] Failed to notify manager:", err)
        )
      )
    );
  } catch (err) {
    console.error("[discord-notify] Failed to send request comment notification:", err);
  }
}

export async function notifyUserIssueResolved(userId: string, title: string, mediaType: string, resolution?: string | null, tmdbId?: number | null): Promise<void> {
  // The resolution note belongs to the issue thread: a DM carries it, the
  // shared channel only says there is one.
  await notifyUser(userId, (t, _locale, local, shared) => {
    const resolutionPart = !resolution
      ? ""
      : shared
        ? `\n\n${t("notify.discord.issueResolved.resolutionShared")}`
        : `\n\n${t("notify.discord.issueResolved.resolution", { resolution: escMd(resolution) })}`;
    return {
      color: COLORS.available,
      title: t("notify.discord.issueResolved.title", { title: escMd(local) }),
      description: `${t("notify.discord.issueResolved.description", { media: mediaLabelT(t, mediaType) })}${resolutionPart}`,
      timestamp: new Date().toISOString(),
    };
  }, "notifyOnIssue", { title, tmdbId, mediaType });
}

type BatchRequest = { requestedBy: string; title: string; mediaType: string; tmdbId?: number | null };

const BATCH_PREF_WHERE = {
  notifyOnApproved: { notifyOnApproved: true },
  notifyOnAvailable: { notifyOnAvailable: true },
  notifyOnDeclined: { notifyOnDeclined: true },
} as const;

// One batch fan-out for the three request-status notifiers: the requesters who
// linked Discord, opted in (`prefKey`) and are not disabled (guardrail 33 —
// account removal keeps the Discord link), each embed written in the language of
// where it lands, its title resolved in that language (guardrail 40a). The shared
// channel is paced in chunks; DMs go through the DM queue. Never throws.
async function notifyUsersBatch<R extends BatchRequest>(
  requests: R[],
  prefKey: keyof typeof BATCH_PREF_WHERE,
  build: (t: Translator, title: string, r: R, shared: boolean) => Embed,
  logLabel: string,
): Promise<void> {
  if (requests.length === 0) return;
  try {
    const cfg = await getConfig();
    if (!cfg) return;

    const userIds = [...new Set(requests.map((r) => r.requestedBy))];
    const users = await prisma.user.findMany({
      where: { id: { in: userIds }, discordId: { not: null }, ...BATCH_PREF_WHERE[prefKey], deactivatedAt: null },
      select: { id: true, discordId: true, locale: true },
    });
    const idMap = new Map(users.map((u) => [u.id, u.discordId!]));
    const userById = new Map(users.map((u) => [u.id, u]));
    const shared = !!cfg.channelId;
    const resolve = await titleResolver(requests, users.map((u) => recipientLocale(shared, u)));

    const tasks = requests.map((r) => () => {
      const discordId = idMap.get(r.requestedBy);
      if (!discordId) return Promise.resolve();
      const locale = recipientLocale(shared, userById.get(r.requestedBy));
      const embed = build(translatorFor(locale), resolve(r, locale), r, shared);
      const send = cfg.channelId
        ? postToChannel(cfg.botToken, cfg.channelId, discordId, embed)
        : enqueueDm(() => sendDm(cfg.botToken, discordId, embed));
      return send.catch((err) => console.error("[discord-notify] Failed to send notification:", err));
    });
    if (cfg.channelId) {
      await chunkSequential(tasks, 5, 600);
    } else {
      await Promise.allSettled(tasks.map((t) => t()));
    }
  } catch (err) {
    console.error(`[discord-notify] Failed to send ${logLabel} notifications:`, err);
  }
}

export async function notifyUsersRequestsApproved(requests: BatchRequest[]): Promise<void> {
  await notifyUsersBatch(requests, "notifyOnApproved", (t, title, r) => approvedEmbed(t, title, r.mediaType), "APPROVED");
}

// Callers pass only claimed, deliverable rows (request-notifications.ts), so the
// shared deactivatedAt filter changes nothing here; it keeps the three alike.
export async function notifyUsersRequestsAvailable(requests: BatchRequest[]): Promise<void> {
  await notifyUsersBatch(requests, "notifyOnAvailable", (t, title, r) => availableEmbed(t, title, r.mediaType), "AVAILABLE");
}

// A row's own `adminNote` (when set, null included) wins over the batch-wide
// one, so a batch can carry each request's stored note.
export async function notifyUsersRequestsDeclined(
  requests: Array<BatchRequest & { adminNote?: string | null }>,
  adminNote?: string | null,
): Promise<void> {
  await notifyUsersBatch(
    requests,
    "notifyOnDeclined",
    (t, title, r, shared) => declinedEmbed(t, title, r.mediaType, r.adminNote !== undefined ? r.adminNote : adminNote, shared),
    "DECLINED",
  );
}
