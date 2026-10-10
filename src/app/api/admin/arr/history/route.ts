import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { arrFailure, arrGate } from "@/lib/arr-admin-http";
import { parseHistoryKind, parsePaging } from "@/lib/arr-history";
import { loadHistoryPage } from "@/lib/arr-history-data";
import { translatorForRequest } from "@/lib/i18n/server-locale";

// Admin → Download History (ADMIN): one instance's history, newest first,
// paged by the arr itself.
//   GET ?service&instance&page=1&pageSize=50[&kind=grabbed|imported|failed|deleted|renamed|ignored]
//   → { page, pageSize, totalRecords, records }. Only named fields of each
//   record's data are returned — never the release's download URL or guid.
export const GET = withAdmin(async (req) => {
  const t = translatorForRequest(req);
  const q = req.nextUrl.searchParams;
  const target = await arrGate(q.get("service"), q.get("instance"), t);
  if (target instanceof NextResponse) return target;
  const paging = parsePaging(q.get("page"), q.get("pageSize"));
  const rawKind = q.get("kind");
  const kind = rawKind === null || rawKind === "" ? null : parseHistoryKind(rawKind);
  if (!paging || kind === null && rawKind !== null && rawKind !== "") {
    return NextResponse.json({ error: t("apiAdmin.arr.pagingInvalid") }, { status: 400 });
  }
  try {
    return NextResponse.json(await loadHistoryPage(target.service, target.instance, paging, kind));
  } catch (err) {
    return arrFailure(err, target, t, "history read");
  }
});
