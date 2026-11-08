import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { arrFailure, arrGate, type ArrTarget } from "@/lib/arr-admin-http";
import { clearBlocklist, loadBlocklistPage } from "@/lib/arr-history-data";
import { auditActor, logAudit } from "@/lib/audit";
import { readJsonCapped } from "@/lib/body-size";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { tooManyRequests } from "@/lib/http";
import { checkRateLimit } from "@/lib/rate-limit";

// Each call queues a ClearBlocklist command on the instance — the same budget
// as Arr System's task runs (10/min per admin, 429 with Retry-After past it).
const LIMIT_PER_MIN = 10;

// The list's size as the arr reports it now, or null when it can't be read.
async function blocklistSize(service: ArrTarget["service"], instance: string): Promise<number | null> {
  try {
    return (await loadBlocklistPage(service, instance, { page: 1, pageSize: 1 })).totalRecords;
  } catch {
    return null;
  }
}

// Admin → Download History → Blocklist, "Clear blocklist" (ADMIN): empties
// one instance's whole blocklist (the arr's own ClearBlocklist command).
//   POST { service, instance, count? } → 202 { ok, commandIds } — or 409 when
//   `count` is sent and the arr's size now differs (nothing is cleared) — `commandIds`
//   is the arr's id for the command, which the page follows and re-reads the
//   list once it ends. The ARR_BLOCKLIST_CHANGE audit (written after the arr
//   accepted the command) records the list's size as the arr reported it just
//   before (`count`, null when that read failed) and, apart, the size the
//   admin confirmed (`confirmedCount`, from the body — client-supplied, so
//   never recorded as the measured one; a mismatch with a measured size is
//   the 409 above). 429 past LIMIT_PER_MIN.
export const POST = withAdmin(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  const body = await readJsonCapped<Record<string, unknown>>(req, 4 * 1024);
  if (body instanceof NextResponse) return body;
  const target = await arrGate(body.service, body.instance, t);
  if (target instanceof NextResponse) return target;
  if (!checkRateLimit(`arr-blocklist-clear:${session.user.id}`, LIMIT_PER_MIN, 60_000)) {
    return tooManyRequests(60, t("apiAdmin.common.tooManyRequestsLater"));
  }
  const confirmedCount = typeof body.count === "number" && Number.isSafeInteger(body.count) && body.count >= 0 ? body.count : null;
  // The list is gone afterwards: measure it now. Best-effort — a failed read
  // never blocks the clear, it leaves the count unknown.
  const count = await blocklistSize(target.service, target.instance);
  // A count the admin confirmed must match the list as it is now: a different
  // size means they confirmed a list that has since changed. Enforced only
  // where a body sends it (the field stays optional), and only against a size
  // that was actually read.
  if (confirmedCount !== null && count !== null && confirmedCount !== count) {
    return NextResponse.json({ error: t("apiAdmin.arr.blocklistCountChanged", { count }), count }, { status: 409 });
  }
  let commandIds: number[];
  try {
    ({ commandIds } = await clearBlocklist(target.service, target.instance));
  } catch (err) {
    return arrFailure(err, target, t, "blocklist clear");
  }
  void logAudit({
    ...auditActor(req, session),
    action: "ARR_BLOCKLIST_CHANGE",
    target: `${target.service}:${target.instance}`,
    details: { service: target.service, instance: target.instance, cleared: true, count, confirmedCount },
  });
  return NextResponse.json({ ok: true, commandIds }, { status: 202 });
});
