import { NextResponse } from "next/server";
import { withIssueAdmin } from "@/lib/api-auth";
import { fixMatchQueueAhead, listFixMatchJobs } from "@/lib/fix-match-jobs";

// Feed for the job tray: every fix-match job the registry still holds (running,
// queued, and finished within the last hour), newest first. In-process like the
// status route — a restart empties it. Coarse on purpose: a title, a server, an
// outcome; never a ratingKey, path or upstream detail.
export const GET = withIssueAdmin(async () => {
  const jobs = listFixMatchJobs().map((j) => ({
    id: j.id,
    status: j.status,
    title: j.title,
    server: j.key.split(":")[0],
    startedAt: j.startedAt,
    finishedAt: j.finishedAt,
    ...(j.status === "queued" ? { queueAhead: fixMatchQueueAhead(j.id) ?? 0 } : {}),
    ...(j.progress ? { progress: { phase: j.progress.phase, attempt: j.progress.attempt, attempts: j.progress.attempts, copy: j.progress.copy, copies: j.progress.copies } } : {}),
    ...(j.result?.warning ? { warning: j.result.warning } : {}),
    ...(j.error ? { error: j.error } : {}),
  }));
  return NextResponse.json({ jobs });
});
