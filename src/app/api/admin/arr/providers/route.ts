import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { snapshotted } from "@/lib/arr-snapshot";
import { ARR_SERVICE_LABEL } from "@/lib/arr-admin";
import { arrFailure, arrGate, parseArrId, type ArrTarget } from "@/lib/arr-admin-http";
import { parseProviderEnableChange, parseProviderKind, type ProviderEnableChange, type ProviderKind } from "@/lib/arr-system";
import { loadProviders, ProviderChangedError, ProviderUseUnsupportedError, ProviderWarningsError, setProviderEnabled } from "@/lib/arr-system-data";
import { auditActor, logAudit } from "@/lib/audit";
import { readJsonCapped } from "@/lib/body-size";
import { tooManyRequests } from "@/lib/http";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import type { Translator } from "@/lib/i18n/translate";
import { checkRateLimit } from "@/lib/rate-limit";
import { answerOf, jobResponse, runningArrJob, startArrJob } from "@/lib/release-search-jobs";

// Saves per admin per minute: one per switch flipped, so this bounds a runaway
// client (each save reads the provider, may run the arr's test, and writes it
// back). Joining a background save already running spends nothing.
const SAVE_LIMIT_PER_MIN = 30;

type ProviderPatch = {
  kind: ProviderKind;
  id: number;
  change: ProviderEnableChange;
  acceptWarnings: boolean;
  background: boolean;
};

// The body's switch, or null when any field is malformed (400, nothing sent).
function parseProviderPatch(body: Record<string, unknown>): ProviderPatch | null {
  const kind = parseProviderKind(body.kind);
  const id = parseArrId(body.id);
  const change = kind ? parseProviderEnableChange(kind, body) : null;
  const { acceptWarnings, async: background } = body;
  if (!kind || id === null || typeof body.id !== "number" || !change) return null;
  if (acceptWarnings !== undefined && typeof acceptWarnings !== "boolean") return null;
  if (background !== undefined && typeof background !== "boolean") return null;
  return { kind, id, change, acceptWarnings: acceptWarnings === true, background: background === true };
}

// The arr's refusals the page shows as their own answers; anything else is the
// shared Radarr/Sonarr failure map.
function providerSaveFailure(err: unknown, target: ArrTarget, kind: ProviderKind, t: Translator): NextResponse {
  const service = ARR_SERVICE_LABEL[target.service];
  if (err instanceof ProviderUseUnsupportedError) {
    return NextResponse.json(
      { error: t(err.use === "rss" ? "apiAdmin.arr.providerRssUnsupported" : "apiAdmin.arr.providerSearchUnsupported", { service }) },
      { status: 400 },
    );
  }
  if (err instanceof ProviderChangedError) {
    return NextResponse.json({ error: t("apiAdmin.arr.providerChangedMeanwhile", { service }), changed: true }, { status: 409 });
  }
  if (err instanceof ProviderWarningsError) {
    const reason = err.messages.join(" ") || t("apiAdmin.arr.noReason");
    return NextResponse.json(
      { error: t("apiAdmin.arr.providerWarnings", { service, reason }), warningsOnly: true, messages: err.messages },
      { status: 409 },
    );
  }
  return arrFailure(err, target, t, `${kind} change`);
}

// One save, answered as the route answers it. `actor` is read off the request
// up front: a background job outlives it.
async function saveProviderChange(
  target: ArrTarget,
  patch: ProviderPatch,
  actor: ReturnType<typeof auditActor>,
  t: Translator,
): Promise<NextResponse> {
  const { kind, id, change, acceptWarnings, background } = patch;
  let result;
  try {
    result = await setProviderEnabled(target.service, target.instance, kind, id, change, {
      acceptWarnings,
      settle: background ? "wait" : "once",
    });
  } catch (err) {
    return providerSaveFailure(err, target, kind, t);
  }
  const { provider, applied, timedOut } = result;
  if (!applied) {
    const service = ARR_SERVICE_LABEL[target.service];
    return NextResponse.json({ error: t("apiAdmin.arr.providerSaveTimedOut", { service }), provider, timedOut: true }, { status: 504 });
  }
  void logAudit({
    ...actor,
    action: "ARR_PROVIDER_CHANGE",
    target: `${target.service}:${target.instance}:${kind}:${id}`,
    details: {
      service: target.service,
      instance: target.instance,
      kind,
      id,
      name: provider.name,
      change,
      // Only when it turned something ON — the one save where warnings stood in the way.
      ...(acceptWarnings && Object.values(change).includes(true) ? { acceptedWarnings: true } : {}),
    },
  });
  return NextResponse.json(timedOut ? { provider, timedOut: true } : { provider });
}

// Admin → Arr System → Indexers & clients (ADMIN).
//   GET → { instances, errors, results: [{ service, instance, indexers, downloadClients, tags }] }:
//       every configured instance's indexers (protocol, priority, which uses
//       are on, whether Prowlarr manages one) and download clients, and the
//       instance's tag names. Never their settings — those hold API keys,
//       passkeys and passwords.
//   GET ?job=<id> → a background save's poll (below): 202 { job, running }
//       while it runs, then the save's own answer, 404 once the job is gone.
//   PATCH { service, instance, kind: "indexer", id, enableRss?, enableAutomaticSearch?, enableInteractiveSearch?, acceptWarnings?, async? }
//   PATCH { service, instance, kind: "downloadClient", id, enable, acceptWarnings?, async? } — switch
//       them. The arr's own resource is read and saved back with only those
//       flags changed, server-side.
//       • Saves to one provider are taken one at a time, server-side: each
//         reads the arr's resource only once the save before it has finished,
//         so two overlapping saves never put back each other's flag.
//       • A use the indexer reports it can't do (the arr's supportsRss /
//         supportsSearch false) is never switched ON: 400, nothing sent.
//       • A change that only turns things off is saved without the arr's test (forceSave).
//       • Switching one ON lets the arr test it: a failing test is 400 with its
//         (masked) reason; a test that only WARNED is 409 { warningsOnly: true,
//         messages } — nothing saved.
//       • acceptWarnings: true (after that 409) re-runs the arr's test here and
//         saves with forceSave only when it reports warnings alone (else 400)
//         — and only when the resource, read again after the test, is still
//         the one tested (an edit made in the arr meanwhile → 409
//         { error, changed: true }, nothing saved).
//       • A testing save the arr hasn't finished within the wait (120 s) is
//         read back: saved → 200 { provider, timedOut: true }; not (yet) saved
//         → 504 { error, provider, timedOut: true }.
//       → { provider } as saved. Audited ARR_PROVIDER_CHANGE once the change
//       is in the arr, never for a refusal.
//       • async: true → 202 { job } at once and the save runs in the
//         background (release-search-jobs.ts): a testing save can wait past
//         what a reverse proxy holds a request (the 37a lesson — the browser
//         got a proxy 504 while the save landed and was audited). Poll GET
//         ?job=. A background save that times out is re-read until the arr
//         holds the change or PROVIDER_SETTLE_READS reads have passed, so a
//         save landing in that window answers 200 and IS audited; one landing
//         after it is still answered 504 and not audited. The same save while
//         one runs joins it. Without `async` the request waits, as before
//         (one read-back) — the contract API callers have.
//       • 429 past SAVE_LIMIT_PER_MIN per admin, checked after the body; a
//         save that joins one already running spends nothing.
// GET with `cached=1` → the last answer kept for this exact read, for display only
// (src/lib/arr-snapshot.ts); a job poll is never kept.
export const GET = withAdmin(snapshotted(async (req, _ctx, session) => {
  const job = req.nextUrl.searchParams.get("job");
  if (job !== null) return jobResponse(session.user.id, job, translatorForRequest(req), "apiAdmin.arr.providerJobGone");
  return NextResponse.json(await loadProviders());
}));

export const PATCH = withAdmin(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  const body = await readJsonCapped<Record<string, unknown>>(req, 4 * 1024);
  if (body instanceof NextResponse) return body;
  const target = await arrGate(body.service, body.instance, t);
  if (target instanceof NextResponse) return target;
  const patch = parseProviderPatch(body);
  if (!patch) return NextResponse.json({ error: t("apiAdmin.arr.providerBodyInvalid") }, { status: 400 });
  const owner = session.user.id;
  // The same change to the same provider while one runs is joined (startArrJob), never sent twice.
  const key = ["provider-save", target.service, target.instance, patch.kind, patch.id, JSON.stringify(patch.change), patch.acceptWarnings].join("\u0000");
  const running = patch.background ? runningArrJob(owner, key) : null;
  if (running) return NextResponse.json({ job: running }, { status: 202 });
  if (!checkRateLimit(`arr-provider-change:${owner}`, SAVE_LIMIT_PER_MIN, 60_000)) {
    return tooManyRequests(60, t("apiAdmin.common.tooManyRequestsLater"));
  }
  const actor = auditActor(req, session);
  if (!patch.background) return saveProviderChange(target, patch, actor, t);
  const { jobId } = startArrJob(owner, key, async () => answerOf(await saveProviderChange(target, patch, actor, t)));
  return NextResponse.json({ job: jobId }, { status: 202 });
});
