import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { searchImportTargets } from "@/lib/arr-queue-data";
import { importFailure, serviceGate } from "@/lib/arr-queue-http";
import { translatorForRequest } from "@/lib/i18n/server-locale";

// Admin → Download Queue → Import, "match to…" search (ADMIN): titles the
// INSTANCE HAS (a manual import needs the movie/series in the arr already)
// matching `term`, through the arr's own lookup — at most 25.
export const GET = withAdmin(async (req) => {
  const t = translatorForRequest(req);
  const params = req.nextUrl.searchParams;
  const target = await serviceGate(params.get("service"), params.get("instance"), t);
  if (target instanceof NextResponse) return target;
  const term = (params.get("term") ?? "").trim();
  if (term.length < 1 || term.length > 100) {
    return NextResponse.json({ error: t("apiAdmin.queue.termInvalid") }, { status: 400 });
  }
  try {
    return NextResponse.json({ results: await searchImportTargets(target.service, target.instance, term) });
  } catch (err) {
    return importFailure(err, target.service, target.instance, t, "title search");
  }
});
