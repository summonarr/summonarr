import { NextResponse } from "next/server";
import { withIssueAdmin } from "@/lib/api-auth";
import { fixMatchJobScope, fixMatchQueueAhead, listFixMatchJobs } from "@/lib/fix-match-jobs";

// Feed for the job tray: every fix-match job the registry still holds (running,
// queued, and finished within the last hour), newest first. In-process like the
// status route — a restart empties it. Coarse on purpose: a title, a server, an
// outcome; never a ratingKey, path or upstream detail. `serverInstance` is the
// slug ("" = default) so two servers' jobs for one title read apart.
export const GET = withIssueAdmin(async () => {
  const jobs = listFixMatchJobs().map((j) => {
    const { server, serverInstance } = fixMatchJobScope(j.key);
    return {
      id: j.id,
      status: j.status,
      title: j.title,
      server,
      serverInstance,
      startedAt: j.startedAt,
      finishedAt: j.finishedAt,
      ...(j.status === "queued" ? { queueAhead: fixMatchQueueAhead(j.id) ?? 0 } : {}),
      ...(j.progress ? { progress: { phase: j.progress.phase, attempt: j.progress.attempt, attempts: j.progress.attempts, copy: j.progress.copy, copies: j.progress.copies } } : {}),
      ...(j.result?.warning ? { warning: j.result.warning } : {}),
      ...(j.error ? { error: j.error } : {}),
    };
  });
  return NextResponse.json({ jobs });
});
