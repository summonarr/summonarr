import type { FeatureFlags } from "@/lib/features";
import { hasDonationLinks } from "@/lib/donations";
import { parseHiddenRatingSources, type RatingSourceKey } from "@/lib/ratings-visibility";

// What the (app) layout renders from its per-request reads, fully defaulted.
// Pure: the layout does the reads and logs a failure; this only derives.
export interface AppLayoutState {
  motdBody: string;
  motdTitle: string;
  siteTitle: string;
  discordInviteUrl: string;
  userDiscordId: string | null;
  storedLocale: string | null;
  /** True only when the user read succeeded and found the row. */
  localeKnown: boolean;
  maintenanceEnabled: boolean;
  maintenanceMessage: string;
  featureFlags: FeatureFlags | undefined;
  hiddenRatingSources: RatingSourceKey[];
}

export interface AppLayoutReads {
  /** The layout's Setting rows; [] when the read failed. */
  rows: ReadonlyArray<{ key: string; value: string }>;
  /** undefined when the flags read failed. */
  flags: FeatureFlags | undefined;
  /** undefined when the user read failed; null when it found no row. */
  user: { discordId: string | null; locale: string | null } | null | undefined;
  /** Whether the user read itself succeeded (a null row is still a success). */
  userReadOk: boolean;
}

export function appLayoutStateFrom({ rows, flags, user, userReadOk }: AppLayoutReads): AppLayoutState {
  const cfg: Record<string, string | undefined> = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  // With the user read failed, whether they already joined is unknown: skip
  // the join prompt rather than nag a member.
  const discordInviteUrl = userReadOk ? (cfg.discordInviteUrl ?? "") : "";
  return {
    hiddenRatingSources: parseHiddenRatingSources(cfg.ratingsHiddenSources),
    motdBody: cfg.motdEnabled === "true" ? (cfg.motdBody ?? "") : "",
    motdTitle: cfg.motdTitle ?? "",
    siteTitle: cfg.siteTitle ?? "",
    discordInviteUrl,
    maintenanceEnabled: cfg.maintenanceEnabled === "true",
    maintenanceMessage: cfg.maintenanceMessage ?? "",
    // Auto-hide the Donate nav link when no donation methods are configured —
    // nothing to link to, regardless of the feature toggle.
    featureFlags: flags && (hasDonationLinks(cfg) ? flags : { ...flags, "feature.page.donate": false }),
    userDiscordId: discordInviteUrl ? (user?.discordId ?? null) : null,
    storedLocale: user?.locale ?? null,
    // Only a successful read that found the row: a failed one must not look
    // like "never stored".
    localeKnown: user != null,
  };
}
