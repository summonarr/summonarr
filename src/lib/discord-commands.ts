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
// Option types: 1 = SUB_COMMAND (carries its own `options`), 3 = STRING,
// 4 = INTEGER (bounded by min_value/max_value). Discord requires every required
// option to come before the optional ones.
//
// Kept in a leaf module with zero imports: the registration paths carry no
// runtime dependency on each other, and the schema stays unit-testable.

/**
 * Length of the `/link` token minted by /api/discord/generate-link
 * (`randomBytes(16).toString("hex")` ⇒ 16 bytes ⇒ 32 hex characters).
 * The token option's `max_length` must never be below this.
 */
export const DISCORD_LINK_TOKEN_LENGTH = 32;

export type DiscordCommandOption = {
  readonly name: string;
  readonly description: string;
  readonly type: number;
  // Absent on a SUB_COMMAND (type 1), which is not itself "required".
  readonly required?: boolean;
  readonly min_length?: number;
  readonly max_length?: number;
  readonly min_value?: number;
  readonly max_value?: number;
  readonly choices?: readonly { readonly name: string; readonly value: string }[];
  // A SUB_COMMAND's own options.
  readonly options?: readonly DiscordCommandOption[];
};

/** The `/issue` note's cap — Issue.note's limit (src/lib/issue-create.ts MAX_ISSUE_NOTE_LENGTH). */
export const DISCORD_ISSUE_NOTE_MAX = 1000;
/** Season/episode ceiling — src/lib/issue-create.ts MAX_SEASON_EPISODE (Issue's INT4 columns). */
export const DISCORD_SEASON_EPISODE_MAX = 10_000;

const TYPE_CHOICES = [
  { name: "Movie", value: "movie" },
  { name: "TV Show", value: "tv" },
] as const;

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
        choices: TYPE_CHOICES,
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
  {
    name: "watchlist",
    description: "Add to or manage your watchlist",
    options: [
      {
        name: "add",
        description: "Add a movie or TV show to your watchlist",
        type: 1,
        options: [
          { name: "type", description: "Movie or TV show", type: 3, required: true, choices: TYPE_CHOICES },
          { name: "query", description: "Title to search for", type: 3, required: true, min_length: 1, max_length: 200 },
        ],
      },
      {
        name: "list",
        description: "Show your watchlist and remove titles from it",
        type: 1,
      },
    ],
  },
  {
    name: "issue",
    description: "Report a problem with a movie or TV show in the library",
    options: [
      { name: "type", description: "Movie or TV show", type: 3, required: true, choices: TYPE_CHOICES },
      { name: "query", description: "Title to search for", type: 3, required: true, min_length: 1, max_length: 200 },
      {
        name: "problem",
        description: "What is wrong",
        type: 3,
        required: true,
        // Values are the IssueType enum (src/lib/issue-create.ts VALID_ISSUE_TYPES).
        choices: [
          { name: "Bad video", value: "BAD_VIDEO" },
          { name: "Wrong audio", value: "WRONG_AUDIO" },
          { name: "Missing subtitles", value: "MISSING_SUBTITLES" },
          { name: "Wrong match", value: "WRONG_MATCH" },
          { name: "Other", value: "OTHER" },
        ],
      },
      { name: "note", description: "Details for the admins", type: 3, required: false, min_length: 1, max_length: DISCORD_ISSUE_NOTE_MAX },
      { name: "season", description: "Season number (TV only)", type: 4, required: false, min_value: 1, max_value: DISCORD_SEASON_EPISODE_MAX },
      { name: "episode", description: "Episode number (TV only, needs a season)", type: 4, required: false, min_value: 1, max_value: DISCORD_SEASON_EPISODE_MAX },
    ],
  },
  {
    name: "recent",
    description: "See what was recently added to the library",
    options: [
      { name: "type", description: "Only movies or only TV shows", type: 3, required: false, choices: TYPE_CHOICES },
    ],
  },
];
