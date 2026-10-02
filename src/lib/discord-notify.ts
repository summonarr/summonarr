import { prisma } from "@/lib/prisma";
import { safeFetchTrusted } from "@/lib/safe-fetch";
import { isFeatureEnabled } from "@/lib/features";
import { hasPermission, Permission, effectivePermissions, parsePermissions } from "@/lib/permissions";
import { instanceDefaultLocale, localeForUser, translatorFor } from "@/lib/i18n/server-locale";
import type { Translator } from "@/lib/i18n/translate";
import type { Locale } from "@/lib/i18n/locales";
import { localizedTitleFor, titleResolver, type TitleRef } from "@/lib/tmdb-localize";
import { discordIssueTypeLabelT, mediaLabelT } from "@/lib/notify-i18n";

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

function escMd(text: string): string {
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

export async function assignDiscordRolesOnLink(discordUserId: string, userEmail: string, userRole: "ADMIN" | "ISSUE_ADMIN" | "USER" = "USER"): Promise<void> {
  try {
    if (!(await isFeatureEnabled("feature.integration.discord"))) return;
    const rows = await prisma.setting.findMany({
      where: { key: { in: ["discordBotToken", "discordGuildId", "discordLinkedRoleId", "discordPlexRoleId", "discordJellyfinRoleId", "discordAdminRoleId", "discordIssueAdminRoleId"] } },
    });
    const cfg = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    if (!cfg.discordBotToken || !cfg.discordGuildId) return;
    if (!isValidSnowflake(cfg.discordGuildId) || !isValidSnowflake(discordUserId)) return;

    // Synthetic @jellyfin.local email is the only reliable way to distinguish Jellyfin-only accounts at link time
    const isJellyfin = userEmail.endsWith("@jellyfin.local");
    const serverRoleId = isJellyfin ? cfg.discordJellyfinRoleId : cfg.discordPlexRoleId;
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
    const managed = [
      cfg.discordLinkedRoleId,
      cfg.discordPlexRoleId,
      cfg.discordJellyfinRoleId,
      cfg.discordAdminRoleId,
      cfg.discordIssueAdminRoleId,
    ].filter((id): id is string => isValidSnowflake(id));
    const stale = [...new Set(managed)].filter((id) => !desired.has(id));

    if (roleIds.length === 0 && stale.length === 0) return;

    const memberRoleUrl = (roleId: string) =>
      `${DISCORD_API}/guilds/${cfg.discordGuildId}/members/${discordUserId}/roles/${roleId}`;
    const auth = { Authorization: `Bot ${cfg.discordBotToken}`, "Content-Type": "application/json" };

    await Promise.allSettled([
      ...roleIds.map((roleId) =>
        safeFetchTrusted(memberRoleUrl(roleId), {
          allowedHosts: DISCORD_HOSTS,
          method: "PUT",
          headers: auth,
          timeoutMs: DISCORD_FETCH_TIMEOUT_MS,
        }).then(async (res) => {
          if (!res.ok) {
            const text = await res.text();
            console.error(`[discord-notify] Failed to assign role ${roleId} (${res.status}): ${text}`);
          }
        })
      ),
      ...stale.map((roleId) =>
        safeFetchTrusted(memberRoleUrl(roleId), {
          allowedHosts: DISCORD_HOSTS,
          method: "DELETE",
          headers: auth,
          timeoutMs: DISCORD_FETCH_TIMEOUT_MS,
        }).then(async (res) => {
          // 404 is the common, benign case: the member never had the role.
          if (!res.ok && res.status !== 404) {
            const text = await res.text();
            console.error(`[discord-notify] Failed to revoke role ${roleId} (${res.status}): ${text}`);
          }
        })
      ),
    ]);
  } catch (err) {
    console.error("[discord-notify] assignDiscordRolesOnLink failed:", err);
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
export async function revokeDiscordRolesOnUnlink(discordUserId: string): Promise<void> {
  try {
    if (!(await isFeatureEnabled("feature.integration.discord"))) return;
    const rows = await prisma.setting.findMany({
      where: { key: { in: ["discordBotToken", "discordGuildId", "discordLinkedRoleId", "discordPlexRoleId", "discordJellyfinRoleId", "discordAdminRoleId", "discordIssueAdminRoleId"] } },
    });
    const cfg = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    if (!cfg.discordBotToken || !cfg.discordGuildId) return;
    if (!isValidSnowflake(cfg.discordGuildId) || !isValidSnowflake(discordUserId)) return;

    const managed = [...new Set([
      cfg.discordLinkedRoleId,
      cfg.discordPlexRoleId,
      cfg.discordJellyfinRoleId,
      cfg.discordAdminRoleId,
      cfg.discordIssueAdminRoleId,
    ].filter((id): id is string => isValidSnowflake(id)))];
    if (managed.length === 0) return;

    await Promise.allSettled(
      managed.map((roleId) =>
        safeFetchTrusted(`${DISCORD_API}/guilds/${cfg.discordGuildId}/members/${discordUserId}/roles/${roleId}`, {
          allowedHosts: DISCORD_HOSTS,
          method: "DELETE",
          headers: { Authorization: `Bot ${cfg.discordBotToken}`, "Content-Type": "application/json" },
          timeoutMs: DISCORD_FETCH_TIMEOUT_MS,
        }).then(async (res) => {
          // 404 = the member never had the role (or already left the guild).
          if (!res.ok && res.status !== 404) {
            const text = await res.text();
            console.error(`[discord-notify] Failed to revoke role ${roleId} on unlink (${res.status}): ${text}`);
          }
        })
      )
    );
  } catch (err) {
    console.error("[discord-notify] revokeDiscordRolesOnUnlink failed:", err);
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

    const res = await safeFetchTrusted(`${DISCORD_API}/channels/${cfg.discordAdminRequestChannelId}/messages`, {
      allowedHosts: DISCORD_HOSTS,
      method: "POST",
      headers: { Authorization: `Bot ${cfg.discordBotToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: [clampEmbed(embed)], components, allowed_mentions: { parse: [] } }),
      timeoutMs: DISCORD_FETCH_TIMEOUT_MS,
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

    const res = await safeFetchTrusted(`${DISCORD_API}/channels/${cfg.discordAdminRequestChannelId}/messages`, {
      allowedHosts: DISCORD_HOSTS,
      method: "POST",
      headers: { Authorization: `Bot ${cfg.discordBotToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: [clampEmbed(embed)], allowed_mentions: { parse: [] } }),
      timeoutMs: DISCORD_FETCH_TIMEOUT_MS,
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
  const res = await safeFetchTrusted(`${DISCORD_API}/channels/${channelId}/messages`, {
    allowedHosts: DISCORD_HOSTS,
    method: "POST",
    headers: { Authorization: `Bot ${botToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      content: `<@${discordId}>`,
      embeds: [clampEmbed(embed)],
      // parse:[] suppresses @everyone/@here; explicit users array allows the single target mention
      allowed_mentions: { parse: [], users: [discordId] },
    }),
    timeoutMs: DISCORD_FETCH_TIMEOUT_MS,
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
  const dmRes = await safeFetchTrusted(`${DISCORD_API}/users/@me/channels`, {
    allowedHosts: DISCORD_HOSTS,
    method: "POST",
    headers: { Authorization: `Bot ${botToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ recipient_id: discordId }),
    timeoutMs: DISCORD_FETCH_TIMEOUT_MS,
  });
  if (!dmRes.ok) {
    const text = await dmRes.text();
    throw new Error(`Failed to open DM channel (${dmRes.status}): ${text}`);
  }
  const { id: channelId } = await dmRes.json() as { id: string };
  const msgRes = await safeFetchTrusted(`${DISCORD_API}/channels/${channelId}/messages`, {
    allowedHosts: DISCORD_HOSTS,
    method: "POST",
    headers: { Authorization: `Bot ${botToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ embeds: [clampEmbed(embed)] }),
    timeoutMs: DISCORD_FETCH_TIMEOUT_MS,
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
  build: (t: Translator, locale: Locale, title: string) => Embed,
  prefKey?: "notifyOnApproved" | "notifyOnAvailable" | "notifyOnDeclined" | "notifyOnIssue",
  titleRef?: TitleRef,
): Promise<void> {
  try {
    const cfg = await getConfig();
    if (!cfg) return;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { discordId: true, notifyOnApproved: true, notifyOnAvailable: true, notifyOnDeclined: true, notifyOnIssue: true, locale: true },
    });
    if (!user?.discordId) return;
    if (prefKey && user[prefKey] === false) return;

    const locale = recipientLocale(!!cfg.channelId, user);
    const title = titleRef ? (await titleResolver([titleRef], [locale]))(titleRef, locale) : "";
    const embed = build(translatorFor(locale), locale, title);
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

function declinedEmbed(t: Translator, title: string, mediaType: string, adminNote?: string | null): Embed {
  const base = t("notify.discord.declined.description", { media: mediaLabelT(t, mediaType) });
  const description = adminNote
    ? `${base}\n\n${t("notify.discord.declined.note", { note: escMd(adminNote) })}`
    : base;
  return {
    color: COLORS.declined,
    title: t("notify.discord.declined.title", { title: escMd(title) }),
    description,
    timestamp: new Date().toISOString(),
  };
}

export async function notifyUserRequestApproved(userId: string, title: string, mediaType: string, tmdbId?: number | null): Promise<void> {
  await notifyUser(userId, (t, _locale, local) => approvedEmbed(t, local, mediaType), "notifyOnApproved", { title, tmdbId, mediaType });
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
  // formatDigitalRelease (format-release-date.ts).
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

export async function notifyUserRequestDeclined(userId: string, title: string, mediaType: string, adminNote?: string | null, tmdbId?: number | null): Promise<void> {
  await notifyUser(userId, (t, _locale, local) => declinedEmbed(t, local, mediaType, adminNote), "notifyOnDeclined", { title, tmdbId, mediaType });
}

export async function notifyUserIssueMessage(
  userId: string,
  title: string,
  adminName: string,
  body: string,
  media?: { tmdbId?: number | null; mediaType?: string | null },
): Promise<void> {
  await notifyUser(userId, (t, _locale, local) => ({
    color: 0x5865F2,
    title: t("notify.discord.userIssueMessage.title", { title: escMd(local) }),
    description: `${t("notify.discord.userIssueMessage.description", { user: escMd(adminName) })}\n\n> ${escMd(body)}`,
    timestamp: new Date().toISOString(),
  }), "notifyOnIssue", { title, ...media });
}

export async function notifyAdminsIssueMessage(
  title: string,
  userName: string,
  body: string,
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
    const t = channelTranslator();
    const localTitle = await localizedTitleFor({ title, tmdbId: opts.tmdbId, mediaType: opts.mediaType }, null);
    const embed: Embed = {
      color: 0xFEE75C,
      title: opts.fromAdmin
        ? t("notify.discord.adminIssueMessage.titleFromAdmin", { title: escMd(localTitle) })
        : t("notify.discord.adminIssueMessage.title", { title: escMd(localTitle) }),
      description: `${
        opts.fromAdmin
          ? t("notify.discord.adminIssueMessage.descriptionFromAdmin", { user: escMd(userName) })
          : t("notify.discord.adminIssueMessage.description", { user: escMd(userName) })
      }\n\n> ${escMd(body)}`,
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

export async function notifyUserIssueResolved(userId: string, title: string, mediaType: string, resolution?: string | null, tmdbId?: number | null): Promise<void> {
  await notifyUser(userId, (t, _locale, local) => {
    const resolutionPart = resolution
      ? `\n\n${t("notify.discord.issueResolved.resolution", { resolution: escMd(resolution) })}`
      : "";
    return {
      color: COLORS.available,
      title: t("notify.discord.issueResolved.title", { title: escMd(local) }),
      description: `${t("notify.discord.issueResolved.description", { media: mediaLabelT(t, mediaType) })}${resolutionPart}`,
      timestamp: new Date().toISOString(),
    };
  }, "notifyOnIssue", { title, tmdbId, mediaType });
}

export async function notifyUsersRequestsApproved(
  requests: Array<{ requestedBy: string; title: string; mediaType: string; tmdbId?: number | null }>
): Promise<void> {
  if (requests.length === 0) return;
  try {
    const cfg = await getConfig();
    if (!cfg) return;

    const userIds = [...new Set(requests.map((r) => r.requestedBy))];
    const users = await prisma.user.findMany({
      // deactivatedAt: null — account removal disables rather than scrubs
      // (guardrail 33), so a removed user keeps a live Discord link and would
      // otherwise still get pinged by a later batch approve/decline.
      where: { id: { in: userIds }, discordId: { not: null }, notifyOnApproved: true, deactivatedAt: null },
      select: { id: true, discordId: true, locale: true },
    });
    const idMap = new Map(users.map((u) => [u.id, u.discordId!]));
    const userById = new Map(users.map((u) => [u.id, u]));
    // Titles in the language each embed is written in (guardrail 40a).
    const resolve = await titleResolver(requests, users.map((u) => recipientLocale(!!cfg.channelId, u)));

    const tasks = requests.map((r) => () => {
      const discordId = idMap.get(r.requestedBy);
      if (!discordId) return Promise.resolve();
      const locale = recipientLocale(!!cfg.channelId, userById.get(r.requestedBy));
      const t = translatorFor(locale);
      const embed = approvedEmbed(t, resolve(r, locale), r.mediaType);
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
    console.error("[discord-notify] Failed to send APPROVED notifications:", err);
  }
}

export async function notifyUsersRequestsAvailable(
  requests: Array<{ requestedBy: string; title: string; mediaType: string; tmdbId?: number | null }>
): Promise<void> {
  if (requests.length === 0) return;
  try {
    const cfg = await getConfig();
    if (!cfg) return;

    const userIds = [...new Set(requests.map((r) => r.requestedBy))];
    const users = await prisma.user.findMany({
      where: { id: { in: userIds }, discordId: { not: null }, notifyOnAvailable: true },
      select: { id: true, discordId: true, locale: true },
    });
    const idMap = new Map(users.map((u) => [u.id, u.discordId!]));
    const userById = new Map(users.map((u) => [u.id, u]));
    // Titles in the language each embed is written in (guardrail 40a).
    const resolve = await titleResolver(requests, users.map((u) => recipientLocale(!!cfg.channelId, u)));

    const tasks = requests.map((r) => () => {
      const discordId = idMap.get(r.requestedBy);
      if (!discordId) return Promise.resolve();
      const locale = recipientLocale(!!cfg.channelId, userById.get(r.requestedBy));
      const t = translatorFor(locale);
      const embed = availableEmbed(t, resolve(r, locale), r.mediaType);
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
    console.error("[discord-notify] Failed to send AVAILABLE notifications:", err);
  }
}

export async function notifyUsersRequestsDeclined(
  requests: Array<{ requestedBy: string; title: string; mediaType: string; tmdbId?: number | null }>,
  adminNote?: string | null
): Promise<void> {
  if (requests.length === 0) return;
  try {
    const cfg = await getConfig();
    if (!cfg) return;

    const userIds = [...new Set(requests.map((r) => r.requestedBy))];
    const users = await prisma.user.findMany({
      // deactivatedAt: null — see notifyUsersRequestsApproved.
      where: { id: { in: userIds }, discordId: { not: null }, notifyOnDeclined: true, deactivatedAt: null },
      select: { id: true, discordId: true, locale: true },
    });
    const idMap = new Map(users.map((u) => [u.id, u.discordId!]));
    const userById = new Map(users.map((u) => [u.id, u]));
    // Titles in the language each embed is written in (guardrail 40a).
    const resolve = await titleResolver(requests, users.map((u) => recipientLocale(!!cfg.channelId, u)));

    const tasks = requests.map((r) => () => {
      const discordId = idMap.get(r.requestedBy);
      if (!discordId) return Promise.resolve();
      const locale = recipientLocale(!!cfg.channelId, userById.get(r.requestedBy));
      const t = translatorFor(locale);
      const embed = declinedEmbed(t, resolve(r, locale), r.mediaType, adminNote);
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
    console.error("[discord-notify] Failed to send DECLINED notifications:", err);
  }
}
