import { NextResponse } from "next/server";
import { withIssueAdmin } from "@/lib/api-auth";
import { getFixMatchJob } from "@/lib/fix-match-jobs";

// Poll target for a background fix-match started with `async: true` (guardrail
// 37a). ISSUE_ADMIN has access for the same reason the POST does. The registry
// is in-process: a restart loses the job, and the 404 tells the client to
// re-sync rather than retry a remap that may already have landed.
export const GET = withIssueAdmin(async (request, _ctx, _session) => {
  const id = new URL(request.url).searchParams.get("id") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json({ error: "id must be a fix-match job id" }, { status: 400 });
  }
  const job = getFixMatchJob(id);
  if (!job) {
    return NextResponse.json({ error: "Unknown or expired fix-match job" }, { status: 404 });
  }
  return NextResponse.json({
    id: job.id,
    status: job.status,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    ...(job.result ? { result: job.result } : {}),
    ...(job.error ? { error: job.error, errorStatus: job.errorStatus } : {}),
  });
});
