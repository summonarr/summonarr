import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { arrFailure, arrGate, parseArrId } from "@/lib/arr-admin-http";
import { isBulkAction, isTaskName } from "@/lib/arr-system";
import { cancelCommand, loadTasks, runBulkAction, runTask } from "@/lib/arr-system-data";
import { auditContext, logAudit } from "@/lib/audit";
import { readJsonCapped } from "@/lib/body-size";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { checkRateLimit } from "@/lib/rate-limit";

const LIMIT_PER_MIN = 10;

// Admin → Arr System → Tasks (ADMIN).
//   GET → { instances, errors, results: [{ service, instance, tasks, commands }] }:
//       every configured instance's scheduled tasks (last/next run, duration)
//       and its recent commands (newest first; the command body is never sent).
//   POST { service, instance, task } → 202 { id } — run one of the instance's
//       scheduled tasks now (RssSync, Backup, RefreshMovie, …). The name must be
//       one the instance lists as a scheduled task, read now (400 otherwise) —
//       never an arbitrary command.
//   POST { service, instance, action: "searchMissing" | "searchCutoff" } → 202 —
//       search EVERY monitored missing title, or every monitored title below
//       its cutoff (upgrades). Hits every indexer for each.
//   Both are audited ARR_COMMAND after the arr accepted them.
//   DELETE ?service&instance&commandId — cancel a command still QUEUED (409
//       once it started or finished). Not audited.
// Runs are rate-limited per admin.
export const GET = withAdmin(async () => {
  return NextResponse.json(await loadTasks());
});

export const POST = withAdmin(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  const parsed = await readJsonCapped<Record<string, unknown>>(req, 4 * 1024);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  const target = await arrGate(body.service, body.instance, t);
  if (target instanceof NextResponse) return target;
  const task = body.task;
  const action = body.action;
  const isTask = task !== undefined && action === undefined && isTaskName(task);
  const isAction = action !== undefined && task === undefined && isBulkAction(action);
  if (!isTask && !isAction) return NextResponse.json({ error: t("apiAdmin.arr.taskBodyInvalid") }, { status: 400 });
  if (!checkRateLimit(`arr-tasks:${session.user.id}`, LIMIT_PER_MIN, 60_000)) {
    return NextResponse.json({ error: t("apiUser.common.tooManyRequestsLater") }, { status: 429 });
  }
  try {
    const result = isTask
      ? await runTask(target.service, target.instance, task as string)
      : await runBulkAction(target.service, target.instance, action as "searchMissing" | "searchCutoff");
    // Audited both ways: a task such as ApplicationUpdateCheck can install an
    // arr update when run by hand, and a library-wide search hits every indexer.
    void logAudit({
      userId: session.user.id,
      userName: session.user.name ?? session.user.email ?? null,
      action: "ARR_COMMAND",
      target: `${target.service}:${target.instance}`,
      details: { service: target.service, instance: target.instance, ...(isTask ? { task } : { action }) },
      ...auditContext(req, session),
    });
    return NextResponse.json(result, { status: 202 });
  } catch (err) {
    return arrFailure(err, target, t, isTask ? `task ${String(task)}` : `bulk ${String(action)}`);
  }
});

export const DELETE = withAdmin(async (req) => {
  const t = translatorForRequest(req);
  const q = req.nextUrl.searchParams;
  const target = await arrGate(q.get("service"), q.get("instance"), t);
  if (target instanceof NextResponse) return target;
  const commandId = parseArrId(q.get("commandId"));
  if (commandId === null) return NextResponse.json({ error: t("apiAdmin.arr.idInvalid") }, { status: 400 });
  try {
    await cancelCommand(target.service, target.instance, commandId);
  } catch (err) {
    return arrFailure(err, target, t, "command cancel");
  }
  return NextResponse.json({ ok: true });
});
