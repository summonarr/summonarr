import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { snapshotted } from "@/lib/arr-snapshot";
import { arrFailure, arrTitleGate, readWarnKey } from "@/lib/arr-admin-http";
import { loadTitleHistory } from "@/lib/arr-title-data";
import { forgetWarnOnChange } from "@/lib/log-dedup";
import { translatorForRequest } from "@/lib/i18n/server-locale";

// Admin title manager, the title's history (ADMIN): every grab, import,
// failure, deletion, rename and ignored download Radarr/Sonarr recorded for
// it, newest first → { events }. Only named fields of each record's data are
// returned — never the release's download URL or guid, which can embed the
// indexer's apikey. Marking a grab failed is POST /api/admin/arr/history/failed.
// GET with `cached=1` → the last answer kept for this exact read, for display only
// (src/lib/arr-snapshot.ts).
export const GET = withAdmin(snapshotted(async (req) => {
  const t = translatorForRequest(req);
  const q = req.nextUrl.searchParams;
  const target = await arrTitleGate(q.get("service"), q.get("instance"), q.get("id"), t);
  if (target instanceof NextResponse) return target;
  const warnKey = readWarnKey("title-history", target);
  try {
    const events = await loadTitleHistory(target.service, target.instance, target.arrId);
    forgetWarnOnChange(warnKey);
    return NextResponse.json({ events });
  } catch (err) {
    return arrFailure(err, target, t, "title history", { warnKey });
  }
}));
