import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";

// Central registry for admin-toggleable feature flags.
//
// Two kinds of keys show up here:
//   - "feature.*"   — new, Features-tab-native flags (default enabled for most).
//   - legacy keys   — existing Setting rows we expose alongside the new flags so
//                     the Features tab is a single source of truth for on/off
//                     switches (e.g., motdEnabled). The underlying key is reused
//                     to avoid divergent state between the old form and the new
//                     one; changing the legacy key's value via either UI keeps
//                     both in sync.
//
// All values are stored as "true" | "false" strings in the Setting table, the
// same convention used elsewhere in the app (see maintenanceEnabled,
// motdEnabled, etc). A missing row falls back to `defaultEnabled`.

export type FeatureCategory = "pages" | "behaviors" | "integrations" | "admin";

export interface FeatureDefinition {
  key: string;
  label: string;
  description: string;
  category: FeatureCategory;
  defaultEnabled: boolean;
  // Optional — notes shown in the UI when the toggle is partially wired.
  note?: string;
}

export const FEATURE_DEFINITIONS: readonly FeatureDefinition[] = [
  // ── User-facing pages ──────────────────────────────────────────────────
  {
    key: "feature.page.top",
    label: "Top Rated page",
    description: "Show the /top page and its nav link.",
    category: "pages",
    defaultEnabled: true,
  },
  {
    key: "feature.page.popular",
    label: "Popular on Server page",
    description: "Show the /popular page and its nav link.",
    category: "pages",
    defaultEnabled: true,
  },
  {
    key: "feature.page.upcoming",
    label: "Upcoming page",
    description: "Show the /upcoming page and its nav link.",
    category: "pages",
    defaultEnabled: true,
  },
  {
    key: "feature.page.issues",
    label: "Issue reporting",
    description: "Show the /issues page and allow users to file issues on media.",
    category: "pages",
    defaultEnabled: true,
  },
  {
    key: "feature.page.votes",
    label: "Vote to Delete page",
    description: "Show the /votes page and allow users to vote on library deletions.",
    category: "pages",
    defaultEnabled: true,
  },
  {
    key: "feature.page.donate",
    label: "Donate page",
    description: "Show the /donate page and its nav link.",
    category: "pages",
    defaultEnabled: true,
  },

  // ── Behaviors ─────────────────────────────────────────────────────────
  {
    key: "motdEnabled",
    label: "Message of the Day",
    description: "Show a one-time popup to users after login. Configure the body in Site → Message of the Day.",
    category: "behaviors",
    defaultEnabled: false,
  },
  {
    key: "playHistoryEnabled",
    label: "Play history tracking",
    description: "Record playback sessions from Plex/Jellyfin. Configure sources in Media → Play History.",
    category: "behaviors",
    defaultEnabled: false,
  },
  {
    key: "feature.behavior.activeSessions",
    label: "Active sessions widget",
    description: "Show currently-playing sessions on the admin Activity page.",
    category: "behaviors",
    defaultEnabled: true,
  },
  {
    key: "feature.behavior.activityCalendar",
    label: "Activity calendar",
    description: "Show the 365-day viewing heatmap on the admin Activity page.",
    category: "behaviors",
    defaultEnabled: true,
  },

  // ── Integrations ──────────────────────────────────────────────────────
  // Off-switches that layer on top of config presence. A disabled integration
  // stays configured but is treated as unavailable by the app.
  {
    key: "feature.integration.plex",
    label: "Plex",
    description: "Enable Plex sign-in, library sync, and availability badges.",
    category: "integrations",
    defaultEnabled: true,
  },
  {
    key: "feature.integration.jellyfin",
    label: "Jellyfin",
    description: "Enable Jellyfin sign-in, library sync, and availability badges.",
    category: "integrations",
    defaultEnabled: true,
  },
  {
    key: "feature.integration.radarr",
    label: "Radarr",
    description: "Enable Radarr auto-add and availability checks for movies.",
    category: "integrations",
    defaultEnabled: true,
  },
  {
    key: "feature.integration.sonarr",
    label: "Sonarr",
    description: "Enable Sonarr auto-add and availability checks for TV shows.",
    category: "integrations",
    defaultEnabled: true,
  },
  {
    key: "feature.integration.discord",
    label: "Discord bot",
    description: "Enable Discord slash commands, linking, and notifications.",
    category: "integrations",
    defaultEnabled: true,
  },
  {
    key: "feature.integration.email",
    label: "Email notifications",
    description: "Allow the app to send transactional email via SMTP.",
    category: "integrations",
    defaultEnabled: true,
  },
  {
    key: "feature.integration.push",
    label: "Web push notifications",
    description: "Allow users to subscribe to browser push notifications.",
    category: "integrations",
    defaultEnabled: true,
  },

  // ── Admin pages ───────────────────────────────────────────────────────
  {
    key: "feature.admin.stats",
    label: "Statistics page",
    description: "Show the /admin/stats page and nav link.",
    category: "admin",
    defaultEnabled: true,
  },
  {
    key: "feature.admin.activity",
    label: "Activity page",
    description: "Show the /admin/activity page and nav link.",
    category: "admin",
    defaultEnabled: true,
  },
  {
    key: "feature.admin.auditLog",
    label: "Audit Log page",
    description: "Show the /admin/audit-log page and nav link.",
    category: "admin",
    defaultEnabled: true,
  },
  {
    key: "feature.admin.backup",
    label: "Backup page",
    description: "Show the /admin/backup page and nav link.",
    category: "admin",
    defaultEnabled: true,
  },
  {
    key: "trashGuidesEnabled",
    label: "TRaSH Guides",
    description: "Enable the TRaSH Guides admin page and nightly sync.",
    category: "admin",
    defaultEnabled: false,
  },
] as const;

export const FEATURE_KEYS = FEATURE_DEFINITIONS.map((f) => f.key);

export type FeatureKey = (typeof FEATURE_DEFINITIONS)[number]["key"];

export type FeatureFlags = Record<string, boolean>;

export function getFeatureDefaults(): FeatureFlags {
  return Object.fromEntries(FEATURE_DEFINITIONS.map((f) => [f.key, f.defaultEnabled]));
}

/**
 * Read all feature flags in a single query. Missing rows fall back to the
 * registered default. Pass an already-loaded `cfg` map (from an existing
 * prisma.setting.findMany scan) to skip the query if the caller already has
 * the rows.
 */
export async function getFeatureFlags(cfg?: Record<string, string>): Promise<FeatureFlags> {
  let map = cfg;
  if (!map) {
    const rows = await prisma.setting.findMany({ where: { key: { in: [...FEATURE_KEYS] } } });
    map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }
  const out: FeatureFlags = {};
  for (const def of FEATURE_DEFINITIONS) {
    const raw = map[def.key];
    if (raw === "true") out[def.key] = true;
    else if (raw === "false") out[def.key] = false;
    else out[def.key] = def.defaultEnabled;
  }
  return out;
}

/**
 * Server-side check for a single feature. Uses getFeatureFlags internally, so
 * callers that already have a flag map should read it directly.
 */
export async function isFeatureEnabled(key: FeatureKey | string): Promise<boolean> {
  const flags = await getFeatureFlags();
  return flags[key] ?? false;
}

/**
 * Server-side page guard. Throws `notFound()` (i.e. renders the 404 page) if
 * the named feature is disabled. Call at the very top of a page's default
 * export, before any data fetching:
 *
 *   await requireFeature("feature.page.upcoming");
 */
export async function requireFeature(key: FeatureKey | string): Promise<void> {
  const enabled = await isFeatureEnabled(key);
  if (!enabled) notFound();
}

/**
 * Group definitions by category for rendering.
 */
export function groupFeaturesByCategory(): Record<FeatureCategory, FeatureDefinition[]> {
  return {
    pages: FEATURE_DEFINITIONS.filter((f) => f.category === "pages"),
    behaviors: FEATURE_DEFINITIONS.filter((f) => f.category === "behaviors"),
    integrations: FEATURE_DEFINITIONS.filter((f) => f.category === "integrations"),
    admin: FEATURE_DEFINITIONS.filter((f) => f.category === "admin"),
  };
}
