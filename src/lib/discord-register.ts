import "server-only";
import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { safeFetchTrusted } from "@/lib/safe-fetch";
import { DISCORD_SLASH_COMMANDS } from "@/lib/discord-commands";

// Shared Discord slash-command registration. Both the admin "Register commands"
// button and the boot-time self-heal below PUT the canonical
// DISCORD_SLASH_COMMANDS array (a FULL REPLACE) to the guild scope when a Guild
// ID is set — instant, per-server — or the global scope otherwise.

const DISCORD_API = "https://discord.com/api/v10";
const DISCORD_HOSTS = ["discord.com"];

// Non-sensitive (stored plaintext — see settings-sensitive-keys.ts): the SHA of
// the schema that was last registered successfully, keyed so the boot sync can
// tell "already current" from "needs a re-push" without a Discord round-trip.
export const DISCORD_SCHEMA_HASH_KEY = "discordCommandsSchemaHash";

export function discordCommandsUrl(clientId: string, guildId?: string | null): string {
  return guildId
    ? `${DISCORD_API}/applications/${clientId}/guilds/${guildId}/commands`
    : `${DISCORD_API}/applications/${clientId}/commands`;
}

export function putDiscordCommands(botToken: string, clientId: string, guildId?: string | null): Promise<Response> {
  return safeFetchTrusted(discordCommandsUrl(clientId, guildId), {
    method: "PUT",
    headers: { Authorization: `Bot ${botToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(DISCORD_SLASH_COMMANDS),
    allowedHosts: DISCORD_HOSTS,
    timeoutMs: 15_000,
  });
}

// Hash the schema AND its registration scope: a guild↔global switch changes the
// target endpoint, so it must re-register even when the command array is
// identical.
export function discordSchemaHash(guildId: string | null): string {
  return createHash("sha256")
    .update(JSON.stringify(DISCORD_SLASH_COMMANDS))
    .update(guildId ? `guild:${guildId}` : "global")
    .digest("hex");
}

// Record the schema+scope hash after a successful registration so the boot sync
// treats it as current. Called by the admin button and the boot path; a failure
// here only costs one redundant (idempotent) re-registration next boot.
export async function recordDiscordSchemaHash(guildId: string | null): Promise<void> {
  const value = discordSchemaHash(guildId);
  // try/catch (not a trailing .catch): must swallow a SYNCHRONOUS throw too —
  // this is a best-effort bookkeeping write whose failure only costs one
  // redundant, idempotent re-registration on the next boot, and it must never
  // propagate into its caller (the register button / settings save).
  try {
    await prisma.setting.upsert({ where: { key: DISCORD_SCHEMA_HASH_KEY }, update: { value }, create: { key: DISCORD_SCHEMA_HASH_KEY, value } });
  } catch (err) {
    console.warn("[discord] failed to persist command schema hash:", err instanceof Error ? err.message : err);
  }
}

/**
 * Boot-time self-heal: re-register the slash commands ONLY when the schema (or
 * its guild/global scope) changed since the last successful registration.
 *
 * Without this, a command-option change that ships in an upgrade — e.g. the
 * `/link` token option's `max_length` going 20 → 32 — stayed invisible on
 * Discord until an admin happened to click "Register commands", because Discord
 * caches the registered schema. Now the correct schema republishes on the first
 * boot after the upgrade with no manual step.
 *
 * Hash-guarded so an unchanged schema makes NO Discord API call — a
 * crash-looping container can't burn the global-command rate limit. Best-effort:
 * never throws, so a Discord outage at boot can't block startup.
 */
export async function syncDiscordCommandsIfChanged(): Promise<void> {
  const rows = await prisma.setting.findMany({
    where: { key: { in: ["discordBotToken", "discordClientId", "discordGuildId", DISCORD_SCHEMA_HASH_KEY] } },
  });
  const cfg = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  // The prisma extension decrypts discordBotToken on read (guardrail 7a) — cfg
  // carries the plaintext token, exactly what the admin button already uses.
  if (!cfg.discordBotToken || !cfg.discordClientId) return; // Discord not configured

  const guildId = cfg.discordGuildId?.trim() || null;
  if (cfg[DISCORD_SCHEMA_HASH_KEY] === discordSchemaHash(guildId)) return; // already current

  const res = await putDiscordCommands(cfg.discordBotToken, cfg.discordClientId, guildId);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // Leave the stored hash untouched so the next boot retries.
    console.warn(`[discord] boot command sync failed (${res.status}): ${text.slice(0, 200)}`);
    return;
  }
  await recordDiscordSchemaHash(guildId);
}
