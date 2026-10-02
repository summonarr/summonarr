import "server-only";
import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { safeFetchTrusted } from "@/lib/safe-fetch";
import { DISCORD_SLASH_COMMANDS, type DiscordSlashCommand } from "@/lib/discord-commands";
import { LOCALES, type Locale } from "@/lib/i18n/locales";
import { CATALOGS } from "@/lib/i18n/catalogs";

// Shared Discord slash-command registration. The admin "Register commands"
// button, the settings save, and the boot-time self-heal below all PUT the canonical
// DISCORD_SLASH_COMMANDS array, with its localizations, (a FULL REPLACE) to the guild scope when a Guild
// ID is set — instant, per-server — or the global scope otherwise.

const DISCORD_API = "https://discord.com/api/v10";
const DISCORD_HOSTS = ["discord.com"];

// Non-sensitive (stored plaintext — see settings-sensitive-keys.ts): the SHA of
// the schema that was last registered successfully, keyed so the boot sync can
// tell "already current" from "needs a re-push" without a Discord round-trip.
export const DISCORD_SCHEMA_HASH_KEY = "discordCommandsSchemaHash";

// ── Localized picker text ───────────────────────────────────────────────────
// Discord shows each user the command descriptions (and choice labels) in their
// client language when the schema carries *_localizations. Only DESCRIPTIONS
// and CHOICE LABELS are localized — never command or option NAMES: those are
// what people type (the profile page tells users to run `/link token:<code>`),
// and a localized name would make that instruction wrong for half the server.
// Interactions are dispatched on the default name either way.
//
// The English text stays in DISCORD_SLASH_COMMANDS (the dependency-free schema);
// each localized string comes from the catalog key named here, whose English
// value must equal the schema's (pinned by tests/discord-commands.test.mts).

// Our locale → Discord's locale codes (https://discord.com/developers/docs/reference#locales).
const DISCORD_LOCALES: Record<Exclude<Locale, "en">, readonly string[]> = {
  es: ["es-ES", "es-419"],
  fr: ["fr"],
  de: ["de"],
  pt: ["pt-BR"],
  it: ["it"],
  zh: ["zh-CN"],
};

// command → its description key, plus per-option description and choice keys.
export const DISCORD_COMMAND_I18N: Record<string, {
  description: string;
  options?: Record<string, { description: string; choices?: Record<string, string> }>;
}> = {
  request: {
    description: "notify.discordCommand.request.description",
    options: {
      type: {
        description: "notify.discordCommand.request.type.description",
        choices: { movie: "notify.discordCommand.request.type.movie", tv: "notify.discordCommand.request.type.tv" },
      },
      query: { description: "notify.discordCommand.request.query.description" },
    },
  },
  status: { description: "notify.discordCommand.status.description" },
  link: {
    description: "notify.discordCommand.link.description",
    options: { token: { description: "notify.discordCommand.link.token.description" } },
  },
};

function localizationsFor(key: string | undefined): Record<string, string> | undefined {
  if (!key) return undefined;
  const out: Record<string, string> = {};
  for (const locale of LOCALES) {
    if (locale === "en") continue;
    const text = CATALOGS[locale][key];
    if (!text) continue;
    for (const code of DISCORD_LOCALES[locale]) out[code] = text;
  }
  return Object.keys(out).length ? out : undefined;
}

export function localizeDiscordCommands(commands: readonly DiscordSlashCommand[]): unknown[] {
  return commands.map((cmd) => {
    const meta = DISCORD_COMMAND_I18N[cmd.name];
    return {
      ...cmd,
      ...(localizationsFor(meta?.description) ? { description_localizations: localizationsFor(meta?.description) } : {}),
      ...(cmd.options
        ? {
            options: cmd.options.map((opt) => {
              const om = meta?.options?.[opt.name];
              const desc = localizationsFor(om?.description);
              return {
                ...opt,
                ...(desc ? { description_localizations: desc } : {}),
                ...(opt.choices
                  ? {
                      choices: opt.choices.map((c) => {
                        const names = localizationsFor(om?.choices?.[c.value]);
                        return names ? { ...c, name_localizations: names } : c;
                      }),
                    }
                  : {}),
              };
            }),
          }
        : {}),
    };
  });
}

// What every registration path publishes: the canonical schema plus its
// localizations. Computed once — the catalogs are static.
export const REGISTERED_DISCORD_COMMANDS = localizeDiscordCommands(DISCORD_SLASH_COMMANDS);

export function discordCommandsUrl(clientId: string, guildId?: string | null): string {
  return guildId
    ? `${DISCORD_API}/applications/${clientId}/guilds/${guildId}/commands`
    : `${DISCORD_API}/applications/${clientId}/commands`;
}

export function putDiscordCommands(botToken: string, clientId: string, guildId?: string | null): Promise<Response> {
  return safeFetchTrusted(discordCommandsUrl(clientId, guildId), {
    method: "PUT",
    headers: { Authorization: `Bot ${botToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(REGISTERED_DISCORD_COMMANDS),
    allowedHosts: DISCORD_HOSTS,
    timeoutMs: 15_000,
  });
}

// Hash the schema AND its registration scope: a guild↔global switch changes the
// target endpoint, so it must re-register even when the command array is
// identical.
export function discordSchemaHash(guildId: string | null): string {
  return createHash("sha256")
    .update(JSON.stringify(REGISTERED_DISCORD_COMMANDS))
    .update(guildId ? `guild:${guildId}` : "global")
    .digest("hex");
}

// Record the schema+scope hash after a successful registration so the boot sync
// treats it as current. Called by the admin button, the settings save and the
// boot path; a failure here only costs one redundant (idempotent)
// re-registration next boot.
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
