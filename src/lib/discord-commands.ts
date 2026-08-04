// The Discord slash-command schema — the canonical definition, imported by both
// registration paths: the admin "Register commands" button
// (src/app/api/discord/register-commands/route.ts) and the automatic
// re-registration the settings PATCH fires when a Discord key changes
// (src/app/api/settings/route.ts). Both PUT this array to
// /applications/{id}[/guilds/{id}]/commands, which is a FULL REPLACE — whichever
// path ran last defines what the bot exposes.
//
// SINGLE SOURCE OF TRUTH. Don't inline a second copy anywhere. The two used to
// be separate literals and drifted: the settings-triggered copy declared the
// `/link` token option with max_length 20 while the link token is 32 hex chars
// (generate-link mints randomBytes(16).toString("hex")). Discord enforces
// max_length client- AND server-side, so after any settings save the /link flow
// was unusable — the token was rejected before it ever reached the interactions
// handler, and the manual button silently "fixed" it until the next save.
//
// `type: 3` is Discord's STRING application-command option type.
//
// Kept in a leaf module with zero imports: the registration paths carry no
// runtime dependency on each other, and the schema stays unit-testable.

/**
 * Length of the `/link` token minted by /api/discord/generate-link
 * (`randomBytes(16).toString("hex")` ⇒ 16 bytes ⇒ 32 hex characters).
 * The token option's `max_length` must never be below this.
 */
export const DISCORD_LINK_TOKEN_LENGTH = 32;

type DiscordCommandOption = {
  readonly name: string;
  readonly description: string;
  readonly type: number;
  readonly required: boolean;
  readonly min_length?: number;
  readonly max_length?: number;
  readonly choices?: readonly { readonly name: string; readonly value: string }[];
};

export type DiscordSlashCommand = {
  readonly name: string;
  readonly description: string;
  readonly options?: readonly DiscordCommandOption[];
};

export const DISCORD_SLASH_COMMANDS: readonly DiscordSlashCommand[] = [
  {
    name: "request",
    description: "Request a movie or TV show to be added to the library",
    options: [
      {
        name: "type",
        description: "Movie or TV show",
        type: 3,
        required: true,
        choices: [
          { name: "Movie", value: "movie" },
          { name: "TV Show", value: "tv" },
        ],
      },
      {
        name: "query",
        description: "Title to search for",
        type: 3,
        required: true,
        min_length: 1,
        max_length: 200,
      },
    ],
  },
  {
    name: "status",
    description: "Check the status of your recent media requests",
  },
  {
    name: "link",
    description: "Link your Discord account to your Summonarr account",
    options: [
      {
        name: "token",
        description: "Link token from your Profile page",
        type: 3,
        required: true,
        min_length: 1,
        // Must fit the full 32-hex link token — see DISCORD_LINK_TOKEN_LENGTH.
        // Re-run "Register commands" after changing this so Discord picks up
        // the new option schema.
        max_length: DISCORD_LINK_TOKEN_LENGTH,
      },
    ],
  },
];
