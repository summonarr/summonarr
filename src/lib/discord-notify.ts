import { prisma } from "@/lib/prisma";
import { safeFetchTrusted } from "@/lib/safe-fetch";

const DISCORD_API = "https://discord.com/api/v10";
const TMDB_POSTER_BASE = "https://image.tmdb.org/t/p/w185";
const DISCORD_FETCH_TIMEOUT_MS = 15_000;

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
} as const;

interface Embed {
  color: number;
  title: string;
  description: string;
  timestamp: string;
}

async function getConfig(): Promise<{ botToken: string; channelId: string | null } | null> {
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
    if (roleIds.length === 0) return;

    await Promise.allSettled(
      roleIds.map((roleId) =>

        safeFetchTrusted(`${DISCORD_API}/guilds/${cfg.discordGuildId}/members/${discordUserId}/roles/${roleId}`, {
          method: "PUT",
          headers: { Authorization: `Bot ${cfg.discordBotToken}`, "Content-Type": "application/json" },
          timeoutMs: DISCORD_FETCH_TIMEOUT_MS,
        }).then(async (res) => {
          if (!res.ok) {
            const text = await res.text();
            console.error(`[discord-notify] Failed to assign role ${roleId} (${res.status}): ${text}`);
          }
        })
      )
    );
  } catch (err) {
    console.error("[discord-notify] assignDiscordRolesOnLink failed:", err);
  }
}

export async function notifyAdminsNewRequestDiscord(data: {
  requestId: string;
  title: string;
  mediaType: string;
  requestedBy: string;
  note: string | null;
  posterPath: string | null;
}): Promise<void> {
  try {
    const rows = await prisma.setting.findMany({
      where: { key: { in: ["discordBotToken", "discordAdminRequestChannelId"] } },
    });
    const cfg = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    if (!cfg.discordBotToken || !cfg.discordAdminRequestChannelId) return;
    if (!isValidSnowflake(cfg.discordAdminRequestChannelId)) return;

    const label = data.mediaType === "MOVIE" ? "Movie" : "TV Show";
    const embed: Record<string, unknown> = {
      color: COLORS.pending,
      title: `📥 New Request — ${data.title}`,
      description: [
        `**${label}** · requested by **${data.requestedBy}**`,
        data.note ? `\n> ${data.note}` : "",
      ].filter(Boolean).join(""),
      timestamp: new Date().toISOString(),
    };
    if (data.posterPath) {
      embed.thumbnail = { url: `${TMDB_POSTER_BASE}${data.posterPath}` };
    }

    const components = [{
      type: 1,
      components: [
        { type: 2, style: 3, label: "Approve", custom_id: `admin_approve:${data.requestId}`, emoji: { name: "✅" } },
        { type: 2, style: 4, label: "Decline", custom_id: `admin_decline:${data.requestId}`, emoji: { name: "❌" } },
      ],
    }];

    const res = await safeFetchTrusted(`${DISCORD_API}/channels/${cfg.discordAdminRequestChannelId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bot ${cfg.discordBotToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: [embed], components, allowed_mentions: { parse: [] } }),
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

async function postToChannel(botToken: string, channelId: string, discordId: string, embed: Embed): Promise<void> {
  if (!isValidSnowflake(channelId) || !isValidSnowflake(discordId)) {
    throw new Error(`Invalid snowflake: channelId=${channelId} discordId=${discordId}`);
  }
  const res = await safeFetchTrusted(`${DISCORD_API}/channels/${channelId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bot ${botToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      content: `<@${discordId}>`,
      embeds: [embed],
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

// Discord rate-limits DM channel creation; serialise DMs through a queue to avoid 429s when notifying many users
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
    method: "POST",
    headers: { Authorization: `Bot ${botToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ embeds: [embed] }),
    timeoutMs: DISCORD_FETCH_TIMEOUT_MS,
  });
  if (!msgRes.ok) {
    const text = await msgRes.text();
    throw new Error(`Failed to send DM (${msgRes.status}): ${text}`);
  }
}

async function notifyUser(userId: string, embed: Embed, prefKey?: "notifyOnApproved" | "notifyOnAvailable" | "notifyOnDeclined"): Promise<void> {
  try {
    const cfg = await getConfig();
    if (!cfg) return;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { discordId: true, notifyOnApproved: true, notifyOnAvailable: true, notifyOnDeclined: true },
    });
    if (!user?.discordId) return;
    if (prefKey && user[prefKey] === false) return;

    if (cfg.channelId) {
      await postToChannel(cfg.botToken, cfg.channelId, user.discordId, embed);
    } else {
      await enqueueDm(() => sendDm(cfg.botToken, user.discordId!, embed));
    }
  } catch (err) {
    console.error("[discord-notify] Failed to send notification:", err);
  }
}

function mediaLabel(mediaType: string): string {
  return mediaType === "MOVIE" ? "Movie" : "TV Show";
}

export async function notifyUserRequestApproved(userId: string, title: string, mediaType: string): Promise<void> {
  await notifyUser(userId, {
    color: COLORS.approved,
    title: `✅ Request Approved — ${title}`,
    description: `Your **${mediaLabel(mediaType)}** request has been approved and is being downloaded. We'll let you know when it's ready!`,
    timestamp: new Date().toISOString(),
  }, "notifyOnApproved");
}

export async function notifyUserDownloadPending(userId: string, title: string, mediaType: string): Promise<void> {
  await notifyUser(userId, {
    color: COLORS.pending,
    title: `⏳ Download Pending — ${title}`,
    description: `Your **${mediaLabel(mediaType)}** request is approved but hasn't started downloading yet — it may be pending a release or indexer search. We'll notify you when it's ready.`,
    timestamp: new Date().toISOString(),
  }, "notifyOnApproved");
}

export async function notifyUserRequestAvailable(userId: string, title: string, mediaType: string): Promise<void> {
  await notifyUser(userId, {
    color: COLORS.available,
    title: `🎉 Now Available — ${title}`,
    description: `Your **${mediaLabel(mediaType)}** request has finished downloading and should be available to watch shortly!`,
    timestamp: new Date().toISOString(),
  }, "notifyOnAvailable");
}

export async function notifyUserAwaitingRelease(userId: string, title: string, mediaType: string, releaseDate: string | null): Promise<void> {
  const label = mediaLabel(mediaType);
  const releasePart = releaseDate
    ? ` Expected around **${new Date(releaseDate).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })}**.`
    : "";
  await notifyUser(userId, {
    color: COLORS.pending,
    title: `⏰ Awaiting Release — ${title}`,
    description: `Your **${label}** request is approved and queued — it will be downloaded automatically once it's available on home media.${releasePart}`,
    timestamp: new Date().toISOString(),
  }, "notifyOnApproved");
}

export async function notifyUserRequestDeclined(userId: string, title: string, mediaType: string, adminNote?: string | null): Promise<void> {
  const safeNote = adminNote ? escMd(adminNote) : null;
  const description = safeNote
    ? `Your **${mediaLabel(mediaType)}** request was not approved.\n\n**Note:** ${safeNote}`
    : `Your **${mediaLabel(mediaType)}** request was not approved.`;
  await notifyUser(userId, {
    color: COLORS.declined,
    title: `❌ Request Declined — ${escMd(title)}`,
    description,
    timestamp: new Date().toISOString(),
  }, "notifyOnDeclined");
}

export async function notifyUserIssueMessage(userId: string, title: string, adminName: string, body: string): Promise<void> {
  await notifyUser(userId, {
    color: 0x5865F2,
    title: `💬 Admin Reply — ${escMd(title)}`,
    description: `**${escMd(adminName)}** replied to your issue:\n\n> ${escMd(body)}`,
    timestamp: new Date().toISOString(),
  });
}

export async function notifyAdminsIssueMessage(title: string, userName: string, body: string): Promise<void> {
  try {
    const cfg = await getConfig();
    if (!cfg) return;
    if (!cfg.channelId) return;
    if (!isValidSnowflake(cfg.channelId)) return;

    const admins = await (await import("@/lib/prisma")).prisma.user.findMany({
      where: { role: { in: ["ADMIN", "ISSUE_ADMIN"] }, discordId: { not: null }, notifyOnIssue: true },
      select: { discordId: true },
    });
    if (!admins.length) return;

    const embed: Embed = {
      color: 0xFEE75C,
      title: `💬 User Reply on Issue — ${escMd(title)}`,
      description: `**${escMd(userName)}** added a message:\n\n> ${escMd(body)}`,
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

export async function notifyUserIssueResolved(userId: string, title: string, mediaType: string, resolution?: string | null): Promise<void> {
  const label = mediaLabel(mediaType);
  const resolutionPart = resolution ? `\n\n**Resolution:** ${resolution}` : "";
  await notifyUser(userId, {
    color: COLORS.available,
    title: `✅ Issue Resolved — ${title}`,
    description: `The issue you reported with **${label}** has been resolved.${resolutionPart}`,
    timestamp: new Date().toISOString(),
  });
}

export async function notifyUsersRequestsApproved(
  requests: Array<{ requestedBy: string; title: string; mediaType: string }>
): Promise<void> {
  if (requests.length === 0) return;
  try {
    const cfg = await getConfig();
    if (!cfg) return;

    const userIds = [...new Set(requests.map((r) => r.requestedBy))];
    const users = await prisma.user.findMany({
      where: { id: { in: userIds }, discordId: { not: null } },
      select: { id: true, discordId: true },
    });
    const idMap = new Map(users.map((u) => [u.id, u.discordId!]));

    const tasks = requests.map((r) => () => {
      const discordId = idMap.get(r.requestedBy);
      if (!discordId) return Promise.resolve();
      const embed: Embed = {
        color: COLORS.approved,
        title: `✅ Request Approved — ${r.title}`,
        description: `Your **${mediaLabel(r.mediaType)}** request has been approved and is being downloaded. We'll let you know when it's ready!`,
        timestamp: new Date().toISOString(),
      };
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
  requests: Array<{ requestedBy: string; title: string; mediaType: string }>
): Promise<void> {
  if (requests.length === 0) return;
  try {
    const cfg = await getConfig();
    if (!cfg) return;

    const userIds = [...new Set(requests.map((r) => r.requestedBy))];
    const users = await prisma.user.findMany({
      where: { id: { in: userIds }, discordId: { not: null } },
      select: { id: true, discordId: true },
    });
    const idMap = new Map(users.map((u) => [u.id, u.discordId!]));

    const tasks = requests.map((r) => () => {
      const discordId = idMap.get(r.requestedBy);
      if (!discordId) return Promise.resolve();
      const embed: Embed = {
        color: COLORS.available,
        title: `🎉 Now Available — ${r.title}`,
        description: `Your **${mediaLabel(r.mediaType)}** request has finished downloading and should be available to watch shortly!`,
        timestamp: new Date().toISOString(),
      };
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
  requests: Array<{ requestedBy: string; title: string; mediaType: string }>,
  adminNote?: string | null
): Promise<void> {
  if (requests.length === 0) return;
  try {
    const cfg = await getConfig();
    if (!cfg) return;

    const userIds = [...new Set(requests.map((r) => r.requestedBy))];
    const users = await prisma.user.findMany({
      where: { id: { in: userIds }, discordId: { not: null } },
      select: { id: true, discordId: true },
    });
    const idMap = new Map(users.map((u) => [u.id, u.discordId!]));

    const tasks = requests.map((r) => () => {
      const discordId = idMap.get(r.requestedBy);
      if (!discordId) return Promise.resolve();
      const description = adminNote
        ? `Your **${mediaLabel(r.mediaType)}** request was not approved.\n\n**Note:** ${escMd(adminNote)}`
        : `Your **${mediaLabel(r.mediaType)}** request was not approved.`;
      const embed: Embed = {
        color: COLORS.declined,
        title: `❌ Request Declined — ${r.title}`,
        description,
        timestamp: new Date().toISOString(),
      };
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
