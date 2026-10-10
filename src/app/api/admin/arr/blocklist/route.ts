import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { arrFailure, arrGate } from "@/lib/arr-admin-http";
import { parseIdList, parsePaging } from "@/lib/arr-history";
import { loadBlocklistPage, removeFromBlocklist } from "@/lib/arr-history-data";
import { auditContext, logAudit } from "@/lib/audit";
import { translatorForRequest } from "@/lib/i18n/server-locale";

// Admin → Download History → Blocklist (ADMIN): releases Radarr/Sonarr will
// never grab again, one instance at a time.
//   GET ?service&instance&page&pageSize → { page, pageSize, totalRecords, records }
//       — each with the title, release name, quality, indexer and the reason.
//   DELETE ?service&instance&ids=1,2 — take those releases off the blocklist
//       (the arr's bulk DELETE) so they can be grabbed again. Audited
//       ARR_BLOCKLIST_CHANGE after the arr accepted it. Clearing the whole
//       list is POST /api/admin/arr/blocklist/clear.
export const GET = withAdmin(async (req) => {
  const t = translatorForRequest(req);
  const q = req.nextUrl.searchParams;
  const target = await arrGate(q.get("service"), q.get("instance"), t);
  if (target instanceof NextResponse) return target;
  const paging = parsePaging(q.get("page"), q.get("pageSize"));
  if (!paging) return NextResponse.json({ error: t("apiAdmin.arr.pagingInvalid") }, { status: 400 });
  try {
    return NextResponse.json(await loadBlocklistPage(target.service, target.instance, paging));
  } catch (err) {
    return arrFailure(err, target, t, "blocklist read");
  }
});

export const DELETE = withAdmin(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  const q = req.nextUrl.searchParams;
  const target = await arrGate(q.get("service"), q.get("instance"), t);
  if (target instanceof NextResponse) return target;
  const ids = parseIdList(q.get("ids"), 500);
  if (!ids) return NextResponse.json({ error: t("apiAdmin.arr.blocklistIdsInvalid") }, { status: 400 });
  try {
    await removeFromBlocklist(target.service, target.instance, ids);
  } catch (err) {
    return arrFailure(err, target, t, "blocklist remove");
  }
  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email ?? null,
    action: "ARR_BLOCKLIST_CHANGE",
    target: `${target.service}:${target.instance}`,
    details: { service: target.service, instance: target.instance, removed: ids },
    ...auditContext(req, session),
  });
  return NextResponse.json({ removed: ids.length });
});
