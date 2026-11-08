// The OpenAPI document GET /api/openapi serves, assembled from one module per
// area (./paths/*), the shared fragments (./shared) and the named component
// schemas (./components). Type-checked against the OpenAPI 3.0 subset in
// ./types with `satisfies`, so a misspelled keyword fails typecheck. The JSON is
// built once at module load: the document never changes while the process runs.

import { withBasePath } from "@/lib/base-path";
import { components } from "./components";
import { metaPaths } from "./paths/meta";
import { discoveryPaths } from "./paths/discovery";
import { requestsPaths } from "./paths/requests";
import { issuesPaths } from "./paths/issues";
import { listsPaths } from "./paths/lists";
import { playHistoryPaths } from "./paths/play-history";
import { profilePaths } from "./paths/profile";
import { authPaths } from "./paths/auth";
import { discordPaths } from "./paths/discord";
import { adminUsersPaths } from "./paths/admin-users";
import { syncPaths } from "./paths/sync";
import { adminMaintenancePaths } from "./paths/admin-maintenance";
import { adminDebugPaths } from "./paths/admin-debug";
import { adminFixMatchPaths } from "./paths/admin-fix-match";
import { adminLibraryPaths } from "./paths/admin-library";
import { adminDownloadsPaths } from "./paths/admin-downloads";
import { adminArrPaths } from "./paths/admin-arr";
import { adminArrTitlePaths } from "./paths/admin-arr-titles";
import { adminSettingsPaths } from "./paths/admin-settings";
import { settingsPaths } from "./paths/settings";
import { cronPaths } from "./paths/cron";
import type { OpenApiDocument, OpenApiPaths } from "./types";

// Every area's operations. A path belongs to exactly one module; the viewer
// (openapi-viewer.tsx) groups operations by their first tag in `tags` order,
// so the module order here only sets the order of the JSON keys.
export const PATH_MODULES: readonly OpenApiPaths[] = [
  metaPaths,
  discoveryPaths,
  requestsPaths,
  issuesPaths,
  listsPaths,
  playHistoryPaths,
  profilePaths,
  authPaths,
  discordPaths,
  adminUsersPaths,
  syncPaths,
  adminMaintenancePaths,
  adminDebugPaths,
  adminFixMatchPaths,
  adminLibraryPaths,
  adminDownloadsPaths,
  adminArrTitlePaths,
  adminArrPaths,
  adminSettingsPaths,
  settingsPaths,
  cronPaths,
];

function mergePaths(modules: readonly OpenApiPaths[]): OpenApiPaths {
  const out: OpenApiPaths = {};
  for (const m of modules) Object.assign(out, m);
  return out;
}

export const spec = {
  openapi: "3.0.3",
  info: {
    title: "Summonarr API",
    version: "1.0.0",
    description:
      "Internal REST API for Summonarr — media request aggregator with Plex/Jellyfin, Radarr/Sonarr, and TMDB integration.",
  },
  // Next serves every route under BASE_PATH, and a relative server url resolves
  // against the document's origin — without the prefix an external viewer or a
  // generated client would call /api/… on a subpath deployment.
  servers: [{ url: withBasePath("/api"), description: "Application API" }],
  components,
  security: [{ session: [] }, { sessionBearer: [] }],
  tags: [
    { name: "Health", description: "Liveness / readiness probes" },
    { name: "Discovery", description: "Browse / home / popular / upcoming / top-rated lists" },
    { name: "Config", description: "Public client capability negotiation" },
    { name: "Search", description: "TMDB media search" },
    { name: "Requests", description: "Media request lifecycle" },
    { name: "Issues", description: "Content issue reporting" },
    { name: "Votes", description: "Deletion voting" },
    { name: "Lists", description: "Personal watchlist and hidden (\"not interested\") titles" },
    { name: "Notifications", description: "In-app notification inbox" },
    { name: "Ratings", description: "External ratings (MDBList / OMDB)" },
    { name: "Play History", description: "Watch history and sessions" },
    { name: "Sessions", description: "Active playback sessions" },
    { name: "TV", description: "TV episode / season data" },
    { name: "Person", description: "TMDB person credits" },
    { name: "TV Availability", description: "Episode-level availability" },
    { name: "Profile", description: "Authenticated user profile" },
    { name: "Push", description: "Web push notification subscriptions" },
    { name: "Auth", description: "Authentication helpers" },
    { name: "Admin – Users", description: "User management (ADMIN only)" },
    { name: "Admin – Sync", description: "Library sync triggers" },
    { name: "Admin – Stats", description: "System statistics" },
    { name: "Admin – Audit Log", description: "Audit trail" },
    { name: "Admin – Backup", description: "Database export / import" },
    { name: "Admin – Debug", description: "Pipeline inspection" },
    { name: "Admin – Fix Match", description: "Manual metadata correction" },
    { name: "Admin – Cleanup", description: "Library cleanup: rule-based candidates and admin-confirmed deletion (ADMIN only)" },
    { name: "Admin – Never watched", description: "Library titles and seasons nobody has watched in the server's recorded history, checked against each media server's own watch records (ADMIN only, read-only)" },
    { name: "Admin – Watch sync", description: "Pair a Plex account with a Jellyfin user and pick a direction; what one server counts as watched is marked played on the other. Add-only (ADMIN only)" },
    { name: "Admin – Arr", description: "Managing Radarr/Sonarr without opening them: a title's settings, files, history and searches; download history and blocklist; the calendar; tasks, indexers, download clients and storage (ADMIN only)" },
    { name: "Admin – Missing", description: "Radarr/Sonarr titles that should already have a file: released movies and aired episodes — or, in cutoff mode, files below the quality profile's cutoff (ADMIN only)" },
    { name: "Admin – Downloads", description: "Radarr/Sonarr download queues, health checks, the Summonarr webhook connection and \"Open in\" links (ADMIN only)" },
    { name: "Admin – Settings", description: "Radarr/Sonarr and Plex/Jellyfin instance registries, the OIDC sign-in allowlist and outbound notification channels (ADMIN only)" },
    { name: "Discord", description: "Discord OAuth / role sync" },
    { name: "Settings", description: "Application settings (ADMIN only)" },
    { name: "Webhooks", description: "Inbound webhooks from media servers / ARR" },
    { name: "Cron", description: "Scheduled maintenance jobs (CRON_SECRET, or an admin session)" },
    { name: "Events", description: "Server-sent events stream" },
  ],
  paths: mergePaths(PATH_MODULES),
} satisfies OpenApiDocument;

/** The served body: serialized once, not on every request. */
export const SPEC_JSON = JSON.stringify(spec);
