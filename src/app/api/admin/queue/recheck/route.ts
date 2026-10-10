import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { recheckDownloads } from "@/lib/arr-queue-data";
import { checkRateLimit } from "@/lib/rate-limit";
import { translatorForRequest } from "@/lib/i18n/server-locale";

// Admin → Download Queue, "Re-check downloads" (ADMIN): asks every configured,
// enabled Radarr/Sonarr instance to re-check its downloads now
// (RefreshMonitoredDownloads — what the arr does every minute on its own). The
// way to retry a blocked import after fixing its cause without waiting. Queued,
// not awaited; an instance that refused is named in `errors`. Body ignored.
// Writes nothing and changes nothing the arr wasn't about to do anyway, so it
// is not audited; rate-limited per admin.
export const POST = withAdmin(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  if (!checkRateLimit(`queue-recheck:${session.user.id}`, 6, 60_000)) {
    return NextResponse.json({ error: t("apiUser.common.tooManyRequestsLater") }, { status: 429 });
  }
  return NextResponse.json(await recheckDownloads(), { status: 202 });
});
