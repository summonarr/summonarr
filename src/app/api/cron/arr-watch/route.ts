import { defineCronRoute } from "@/lib/cron-route";
import { ARR_WATCH_CRON } from "@/lib/arr-watch-cron";

// The Radarr/Sonarr monitor, scheduled by docker-entrypoint.sh every
// ARR_WATCH_INTERVAL (default 900 s). The job itself — lock, skip rule and run
// — is ARR_WATCH_CRON (src/lib/arr-watch-cron.ts), shared with the
// webhook-driven recount.
export const POST = defineCronRoute(ARR_WATCH_CRON);
