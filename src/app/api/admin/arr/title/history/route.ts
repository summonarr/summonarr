import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { arrFailure, arrTitleGate } from "@/lib/arr-admin-http";
import { loadTitleHistory } from "@/lib/arr-title-data";
import { translatorForRequest } from "@/lib/i18n/server-locale";

// Admin title manager, the title's history (ADMIN): every grab, import,
// failure, deletion, rename and ignored download Radarr/Sonarr recorded for
// it, newest first → { events }. Only named fields of each record's data are
// returned — never the release's download URL or guid, which can embed the
// indexer's apikey. Marking a grab failed is POST /api/admin/arr/history/failed.
export const GET = withAdmin(async (req) => {
  const t = translatorForRequest(req);
  const q = req.nextUrl.searchParams;
  const target = await arrTitleGate(q.get("service"), q.get("instance"), q.get("id"), t);
  if (target instanceof NextResponse) return target;
  try {
    return NextResponse.json({ events: await loadTitleHistory(target.service, target.instance, target.arrId) });
  } catch (err) {
    return arrFailure(err, target, t, "title history");
  }
});
