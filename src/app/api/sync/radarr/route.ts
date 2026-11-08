import { NextRequest, NextResponse } from "next/server";
import { isCronAuthorized } from "@/lib/cron-auth";
import { withCronRunRecording } from "@/lib/cron-history";
import { arrCacheSyncResponse } from "@/lib/arr-sync-route";
import { translatorForRequest } from "@/lib/i18n/server-locale";

export async function POST(req: NextRequest) {
  const t = translatorForRequest(req);
  if (!(await isCronAuthorized(req))) {
    return NextResponse.json({ error: t("apiAdmin.common.forbidden") }, { status: 403 });
  }
  // The refresh and its answer are shared with the Sonarr twin (arr-sync-route.ts).
  return withCronRunRecording("radarr-sync", () => arrCacheSyncResponse("radarr", t));
}
