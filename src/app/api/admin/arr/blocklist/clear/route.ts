import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { arrFailure, arrGate } from "@/lib/arr-admin-http";
import { clearBlocklist } from "@/lib/arr-history-data";
import { auditContext, logAudit } from "@/lib/audit";
import { readJsonCapped } from "@/lib/body-size";
import { translatorForRequest } from "@/lib/i18n/server-locale";

// Admin → Download History → Blocklist, "Clear blocklist" (ADMIN): empties
// one instance's whole blocklist (the arr's own ClearBlocklist command).
//   POST { service, instance } → 202. Audited ARR_BLOCKLIST_CHANGE after the
//   arr accepted it.
export const POST = withAdmin(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  const parsed = await readJsonCapped<Record<string, unknown>>(req, 4 * 1024);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  const target = await arrGate(body.service, body.instance, t);
  if (target instanceof NextResponse) return target;
  try {
    await clearBlocklist(target.service, target.instance);
  } catch (err) {
    return arrFailure(err, target, t, "blocklist clear");
  }
  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email ?? null,
    action: "ARR_BLOCKLIST_CHANGE",
    target: `${target.service}:${target.instance}`,
    details: { service: target.service, instance: target.instance, cleared: true },
    ...auditContext(req, session),
  });
  return NextResponse.json({ ok: true }, { status: 202 });
});
