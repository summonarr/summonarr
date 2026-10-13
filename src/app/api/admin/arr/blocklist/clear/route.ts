import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { arrFailure, arrGate } from "@/lib/arr-admin-http";
import { clearBlocklist } from "@/lib/arr-history-data";
import { auditContext, logAudit } from "@/lib/audit";
import { readJsonCapped } from "@/lib/body-size";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { tooManyRequests } from "@/lib/http";
import { checkRateLimit } from "@/lib/rate-limit";

// Each call queues a ClearBlocklist command on the instance — the same budget
// as Arr System's task runs (10/min per admin, 429 with Retry-After past it).
const LIMIT_PER_MIN = 10;

// Admin → Download History → Blocklist, "Clear blocklist" (ADMIN): empties
// one instance's whole blocklist (the arr's own ClearBlocklist command).
//   POST { service, instance, count? } → 202 { ok, commandIds } — `commandIds`
//   is the arr's id for the command, which the page follows and re-reads the
//   list once it ends. `count` is the size of the list the admin confirmed
//   clearing; it goes into the ARR_BLOCKLIST_CHANGE audit (written after the
//   arr accepted the command), since the list it names is gone afterwards. A
//   missing or malformed count is recorded as null. 429 past LIMIT_PER_MIN.
export const POST = withAdmin(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  const parsed = await readJsonCapped<Record<string, unknown>>(req, 4 * 1024);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  const target = await arrGate(body.service, body.instance, t);
  if (target instanceof NextResponse) return target;
  if (!checkRateLimit(`arr-blocklist-clear:${session.user.id}`, LIMIT_PER_MIN, 60_000)) {
    return tooManyRequests(60, t("apiAdmin.common.tooManyRequestsLater"));
  }
  const count = typeof body.count === "number" && Number.isSafeInteger(body.count) && body.count >= 0 ? body.count : null;
  let commandIds: number[];
  try {
    ({ commandIds } = await clearBlocklist(target.service, target.instance));
  } catch (err) {
    return arrFailure(err, target, t, "blocklist clear");
  }
  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email ?? null,
    action: "ARR_BLOCKLIST_CHANGE",
    target: `${target.service}:${target.instance}`,
    details: { service: target.service, instance: target.instance, cleared: true, count },
    ...auditContext(req, session),
  });
  return NextResponse.json({ ok: true, commandIds }, { status: 202 });
});
