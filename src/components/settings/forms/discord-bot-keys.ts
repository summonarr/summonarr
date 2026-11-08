// The Discord bot form's settings (discord-bot-form.tsx), listed ONCE: the
// settings page reads exactly these keys (NOTIFICATIONS_TAB_KEYS) and builds
// the form's starting values with discordFormInitial. Not a client module, so
// the server page may call it; pure so the unit suite runs it
// (tests/settings-forms-save-state.test.mts).

// Every setting the form saves, by its Setting key. Values are held as the
// strings the route stores (the two checkboxes as "true"/"false"), so a single
// diff against the last saved values covers all of them.
export const DISCORD_KEYS = [
  "discordBotToken",
  "discordClientId",
  "discordGuildId",
  "discordPublicKey",
  "discordAutoApproveRoles",
  "discordRequireLinkedAccount",
  "discordRequireLinkedAccountSite",
  "discordAdminRequestChannelId",
  "discordWelcomeChannelId",
  "discordNotifyChannelId",
  "discordInviteUrl",
  "discordLinkedRoleId",
  "discordPlexRoleId",
  "discordJellyfinRoleId",
  "discordAdminRoleId",
  "discordIssueAdminRoleId",
] as const;

export type DiscordKey = (typeof DISCORD_KEYS)[number];
export type DiscordValues = Record<DiscordKey, string>;

const CHECKBOX_KEYS: ReadonlySet<DiscordKey> = new Set(["discordRequireLinkedAccount", "discordRequireLinkedAccountSite"]);

export interface DiscordFormInitial {
  values: DiscordValues;
  tokenSaved: boolean;
}

/**
 * The form's starting values from the stored settings. The bot token is
 * write-only: its field starts EMPTY (never the token, never the mask as a
 * value — an edit after the mask sent the mask plus the typed text, which
 * the route refuses), and only whether one is saved goes to the browser.
 */
export function discordFormInitial(stored: Partial<Record<DiscordKey, string | null>>): DiscordFormInitial {
  const values = {} as DiscordValues;
  for (const key of DISCORD_KEYS) {
    const raw = stored[key] ?? "";
    values[key] = key === "discordBotToken" ? "" : CHECKBOX_KEYS.has(key) ? (raw === "true" ? "true" : "false") : raw;
  }
  return { values, tokenSaved: Boolean(stored.discordBotToken) };
}

// What Save sends: only the fields that differ from the last saved values.
// Sending all 16 every time caused three problems: a Channels/Roles edit
// re-registered the slash commands with Discord (the route does that whenever
// the ids are in the body), every key got the 10s write cooldown (so saving
// another tab within 10s failed with 429), and the audit log listed 16
// "changed" keys whose values hadn't changed.
//
// A blank token is never sent: the route would drop it and answer ok, and the
// form would then believe the token was gone (see the hint under the field for
// how to turn the bot off).
export function pendingChanges(values: DiscordValues, saved: DiscordValues): Partial<DiscordValues> {
  return Object.fromEntries(
    DISCORD_KEYS.map((key) => [key, values[key]] as const)
      .filter(([key, current]) => current !== saved[key] && !(key === "discordBotToken" && current === "")),
  );
}
