import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { loadArrHealth } from "@/lib/arr-health-data";
import { calendarSiteUrl } from "@/lib/calendar-feed";

// Radarr/Sonarr health (ADMIN): for every configured instance, its version,
// Radarr/Sonarr's own health checks (/api/v3/health), and whether its Connect
// list holds a working Summonarr webhook — enabled for every event Summonarr
// handles and carrying the token Summonarr accepts. Never the token itself.
// `webhookBase` is the address the setup form pre-fills (AUTH_URL + BASE_PATH).
export const GET = withAdmin(async () => {
  const report = await loadArrHealth();
  return NextResponse.json({ ...report, webhookBase: calendarSiteUrl() });
});
