import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { arrFailure, arrGate, parseArrId } from "@/lib/arr-admin-http";
import { parseProviderKind } from "@/lib/arr-system";
import { testProviders } from "@/lib/arr-system-data";
import { readJsonCapped } from "@/lib/body-size";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { checkRateLimit } from "@/lib/rate-limit";
import { answerOf, jobResponse, runningArrJob, startArrJob } from "@/lib/release-search-jobs";

// Two budgets: Test All calls out to EVERY enabled indexer or client of the
// kind, a single test to one. Sharing one small budget meant testing a few
// rows one by one locked the admin out of Test All (and the other way round).
const TEST_ALL_PER_MIN = 6;
const TEST_ONE_PER_MIN = 20;

// Admin → Arr System → Indexers & clients, "Test" (ADMIN).
//   POST { service, instance, kind: "indexer" | "downloadClient", id?, async? } →
//   { results: [{ id, ok, warning, messages }] } — the arr's Test All for the
//   kind (enabled providers only, so an empty list means nothing was enabled
//   to test), or one provider by id (read from the arr and sent back to its
//   test endpoint server-side; its credentials never leave the server).
//   `ok` with `warning` is a provider that works but the arr warned about.
//   Messages are the arr's own, credentials masked. Changes nothing, so not
//   audited; rate-limited per admin, Test All and single tests separately.
//   A test waits on the arr for up to 120 s — past what a reverse proxy holds
//   a request — so `async: true` answers 202 { job } at once and runs it in the
//   background (release-search-jobs.ts); the same test while one runs is
//   joined and spends no rate token. A background Test All waits up to 270 s
//   (the arr tests the providers in turn, and a dead one hangs ~100 s); a
//   synchronous one, and every single test, 120 s.
//   GET ?job=<id> → that test's poll: 202 { job, running } while it runs, then
//   the test's own answer, 404 once the job is gone (expired, another admin's,
//   or dropped by a restart).
export const GET = withAdmin(async (req, _ctx, session) => {
  const job = req.nextUrl.searchParams.get("job") ?? "";
  return jobResponse(session.user.id, job, translatorForRequest(req), "apiAdmin.arr.providerJobGone");
});

export const POST = withAdmin(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  const parsed = await readJsonCapped<Record<string, unknown>>(req, 4 * 1024);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  const target = await arrGate(body.service, body.instance, t);
  if (target instanceof NextResponse) return target;
  const kind = parseProviderKind(body.kind);
  const id = body.id === undefined || body.id === null ? null : parseArrId(body.id);
  const background = body.async;
  if (
    !kind ||
    (body.id !== undefined && body.id !== null && (id === null || typeof body.id !== "number")) ||
    (background !== undefined && typeof background !== "boolean")
  ) {
    return NextResponse.json({ error: t("apiAdmin.arr.providerBodyInvalid") }, { status: 400 });
  }
  const owner = session.user.id;
  const key = ["provider-test", target.service, target.instance, kind, id ?? "all"].join("\u0000");
  // Joining a test already running sends nothing to the arr, so no rate token.
  const running = background === true ? runningArrJob(owner, key) : null;
  if (running) return NextResponse.json({ job: running }, { status: 202 });
  const allowed = id === null
    ? checkRateLimit(`arr-provider-test-all:${owner}`, TEST_ALL_PER_MIN, 60_000)
    : checkRateLimit(`arr-provider-test:${owner}`, TEST_ONE_PER_MIN, 60_000);
  if (!allowed) {
    return NextResponse.json({ error: t("apiUser.common.tooManyRequestsLater") }, { status: 429 });
  }
  const runTest = async (): Promise<NextResponse> => {
    try {
      return NextResponse.json({ results: await testProviders(target.service, target.instance, kind, id, { background: background === true }) });
    } catch (err) {
      return arrFailure(err, target, t, `${kind} test`);
    }
  };
  if (background !== true) return runTest();
  const { jobId } = startArrJob(owner, key, async () => answerOf(await runTest()));
  return NextResponse.json({ job: jobId }, { status: 202 });
});
