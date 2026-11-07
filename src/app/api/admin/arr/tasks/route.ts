import { NextResponse } from "next/server";
import { tooManyRequests } from "@/lib/http";
import { withAdmin } from "@/lib/api-auth";
import { snapshotted } from "@/lib/arr-snapshot";
import { arrFailure, arrGate, parseArrId } from "@/lib/arr-admin-http";
import { isBulkAction, isTaskName, type ArrBulkAction } from "@/lib/arr-system";
import { cancelCommand, loadTasks, runBulkAction, runTask } from "@/lib/arr-system-data";
import { auditContext, logAudit } from "@/lib/audit";
import { readJsonCapped } from "@/lib/body-size";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { checkRateLimit } from "@/lib/rate-limit";

const LIMIT_PER_MIN = 10;

// Admin → Arr System → Tasks (ADMIN).
//   GET → { instances, errors, results: [{ service, instance, tasks, commands }] }:
//       every configured instance's scheduled tasks (last/next run, duration)
//       and its commands — every queued or running one, then the 30 most recent
//       finished, each newest first (the command body is never sent).
//   POST { service, instance, task } → 202 { id } — run one of the instance's
//       scheduled tasks now (RssSync, Backup, RefreshMovie, …). The name must be
//       one the instance lists as a scheduled task, read now (400 otherwise) —
//       never an arbitrary command.
//       The page confirms the two that do more than they say: the update check
//       (Radarr ApplicationCheckUpdate, Sonarr ApplicationUpdateCheck) and a
//       library refresh (RefreshMovie / RefreshSeries) — taskRisk.
//   POST { service, instance, action: "searchMissing" | "searchCutoff" } → 202 —
//       search EVERY monitored missing title, or every monitored title below
//       its cutoff (upgrades). Hits every indexer for each. Radarr's commands
//       take no `monitored` (it searches monitored movies only) and, started
//       from the API, ignore Minimum Availability — bulkActionCommand.
//   Both are audited ARR_COMMAND after the arr accepted them.
//   DELETE ?service&instance&commandId — cancel a command still QUEUED (409
//       once it started or finished — including when it starts between our
//       read and the arr's cancel). Not audited.
// Runs are rate-limited per admin.
// GET with `cached=1` → the last answer kept for this exact read, for display only
// (src/lib/arr-snapshot.ts).
export const GET = withAdmin(snapshotted(async () => {
  return NextResponse.json(await loadTasks());
}));

export const POST = withAdmin(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  const body = await readJsonCapped<Record<string, unknown>>(req, 4 * 1024);
  if (body instanceof NextResponse) return body;
  const target = await arrGate(body.service, body.instance, t);
  if (target instanceof NextResponse) return target;
  const task = body.task;
  const action = body.action;
  // The guards narrow into `run` itself, so no cast stands between a guard and its call.
  const run: { task: string } | { action: ArrBulkAction } | null =
    action === undefined && isTaskName(task) ? { task }
    : task === undefined && isBulkAction(action) ? { action }
    : null;
  if (run === null) return NextResponse.json({ error: t("apiAdmin.arr.taskBodyInvalid") }, { status: 400 });
  if (!checkRateLimit(`arr-tasks:${session.user.id}`, LIMIT_PER_MIN, 60_000)) {
    return tooManyRequests(60, t("apiAdmin.common.tooManyRequestsLater"));
  }
  try {
    const result = "task" in run
      ? await runTask(target.service, target.instance, run.task)
      : await runBulkAction(target.service, target.instance, run.action);
    // Audited both ways: the update check (Radarr ApplicationCheckUpdate,
    // Sonarr ApplicationUpdateCheck) installs an available update and restarts
    // the arr when run by hand, and a library-wide search hits every indexer.
    void logAudit({
      userId: session.user.id,
      userName: session.user.name ?? session.user.email ?? null,
      action: "ARR_COMMAND",
      target: `${target.service}:${target.instance}`,
      details: { service: target.service, instance: target.instance, ...run },
      ...auditContext(req, session),
    });
    return NextResponse.json(result, { status: 202 });
  } catch (err) {
    return arrFailure(err, target, t, "task" in run ? `task ${run.task}` : `bulk ${run.action}`);
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
