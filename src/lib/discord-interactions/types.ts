import type { IssueTypeValue } from "@/lib/issue-create";
import type { Translator } from "@/lib/i18n/translate";

// ── Interaction payload ─────────────────────────────────────────────────────
// Only the fields this endpoint actually reads. The body is signature-verified
// JSON from Discord, parsed once in the route and narrowed on `type`.

export interface DiscordUser {
  id: string;
  username?: string;
}

interface InteractionBase {
  id?: string;
  application_id: string;
  token: string;
  locale?: string;
  guild_id?: string;
  channel_id?: string;
  member?: { user?: DiscordUser; roles?: string[] };
  user?: DiscordUser;
}

export interface CommandOption {
  name: string;
  value?: unknown;
  options?: CommandOption[];
}

export interface CommandData {
  name: string;
  options?: CommandOption[];
}

export interface ComponentData {
  custom_id: string;
  values?: unknown;
}

/** type 1 — Discord's endpoint-verification ping. */
export interface PingInteraction { type: 1 }
/** type 2 — a slash command. */
export interface CommandInteraction extends InteractionBase { type: 2; data: CommandData }
/** type 3 — a button or select-menu click. */
export interface ComponentInteraction extends InteractionBase { type: 3; data: ComponentData }
/** type 4 (autocomplete) / 5 (modal submit): answered with a 400. */
export interface OtherInteraction extends InteractionBase { type: 4 | 5 }

export type DiscordInteraction =
  | PingInteraction
  | CommandInteraction
  | ComponentInteraction
  | OtherInteraction;

/** The invoking user: a guild member's nested user, else the DM user. */
export function discordUserOf(interaction: CommandInteraction | ComponentInteraction): DiscordUser {
  return (interaction.member?.user ?? interaction.user) as DiscordUser;
}

// ── Shared shapes ───────────────────────────────────────────────────────────

export interface TmdbResult {
  id: number;
  title: string;
  mediaType: "movie" | "tv";
  releaseYear: string;
  posterPath: string | null;
  overview: string;
  voteAverage: number;
  plexAvailable?: boolean;
  jellyfinAvailable?: boolean;
  arrPending?: boolean;
  requested?: boolean;
}

export interface PendingSearch {
  results: TmdbResult[];
  discordUserId: string;
  discordUsername: string;
}

export interface PendingWatchlistAdd {
  results: TmdbResult[];
}

export interface PendingIssue {
  results: TmdbResult[];
  issueType: IssueTypeValue;
  note: string | null;
  season: number | null;
  episode: number | null;
}

/** What every slash-command handler is handed. */
export interface CommandContext {
  interaction: CommandInteraction;
  t: Translator;
  appId: string;
  token: string;
  interactionId: string;
  discordUserId: string;
  discordUsername: string;
  data: CommandData;
  /** The `discordRequireLinkedAccount` setting. */
  requireLinked: boolean;
  /** The invoker holds a `discordAutoApproveRoles` role. */
  isExemptByRole: boolean;
}

/** What every component handler is handed. */
export interface ComponentContext {
  interaction: ComponentInteraction;
  /** The clicker's language (their own ephemeral replies). */
  t: Translator;
  /** The instance default — the shared admin-channel embed edits. */
  channelT: Translator;
  appId: string;
  token: string;
  customId: string;
  discordUser: DiscordUser;
  discordUserId: string;
}
