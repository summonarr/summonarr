import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { ARR_SERVICE_LABEL } from "@/lib/arr-admin";
import { arrFailure, arrGate, parseArrId } from "@/lib/arr-admin-http";
import { parseProviderEnableChange, parseProviderKind } from "@/lib/arr-system";
import { loadProviders, ProviderWarningsError, setProviderEnabled } from "@/lib/arr-system-data";
import { auditContext, logAudit } from "@/lib/audit";
import { readJsonCapped } from "@/lib/body-size";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { answerOf, jobResponse, startArrJob } from "@/lib/release-search-jobs";

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
//       • A change that only turns things off is saved without the arr's test (forceSave).
//       • Switching one ON lets the arr test it: a failing test is 400 with its
//         (masked) reason; a test that only WARNED is 409 { warningsOnly: true,
//         messages } — nothing saved.
//       • acceptWarnings: true (after that 409) re-runs the arr's test here and
//         saves with forceSave only when it reports warnings alone (else 400).
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
export const GET = withAdmin(async (req, _ctx, session) => {
  const job = req.nextUrl.searchParams.get("job");
  if (job !== null) return jobResponse(session.user.id, job, translatorForRequest(req), "apiAdmin.arr.providerJobGone");
  return NextResponse.json(await loadProviders());
});

export const PATCH = withAdmin(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  const parsed = await readJsonCapped<Record<string, unknown>>(req, 4 * 1024);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  const target = await arrGate(body.service, body.instance, t);
  if (target instanceof NextResponse) return target;
  const kind = parseProviderKind(body.kind);
  const id = parseArrId(body.id);
  const change = kind ? parseProviderEnableChange(kind, body) : null;
  const acceptWarnings = body.acceptWarnings;
  const background = body.async;
  if (
    !kind || id === null || typeof body.id !== "number" || !change ||
    (acceptWarnings !== undefined && typeof acceptWarnings !== "boolean") ||
    (background !== undefined && typeof background !== "boolean")
  ) {
    return NextResponse.json({ error: t("apiAdmin.arr.providerBodyInvalid") }, { status: 400 });
  }
  const owner = session.user.id;
  const service = ARR_SERVICE_LABEL[target.service];
  // Read off the request now: a background job outlives it.
  const audit = {
    userId: owner,
    userName: session.user.name ?? session.user.email ?? null,
    ...auditContext(req, session),
  };

  const save = async (): Promise<NextResponse> => {
    let result;
    try {
      result = await setProviderEnabled(target.service, target.instance, kind, id, change, {
        acceptWarnings: acceptWarnings === true,
        settle: background === true ? "wait" : "once",
      });
    } catch (err) {
      if (err instanceof ProviderWarningsError) {
        const reason = err.messages.join(" ") || t("apiAdmin.arr.noReason");
        return NextResponse.json(
          { error: t("apiAdmin.arr.providerWarnings", { service, reason }), warningsOnly: true, messages: err.messages },
          { status: 409 },
        );
      }
      return arrFailure(err, target, t, `${kind} change`);
    }
    const { provider, applied, timedOut } = result;
    if (!applied) {
      return NextResponse.json({ error: t("apiAdmin.arr.providerSaveTimedOut", { service }), provider, timedOut: true }, { status: 504 });
    }
    void logAudit({
      ...audit,
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
        ...(acceptWarnings === true && Object.values(change).includes(true) ? { acceptedWarnings: true } : {}),
      },
    });
    return NextResponse.json(timedOut ? { provider, timedOut: true } : { provider });
  };

  if (background !== true) return save();
  // The same change to the same provider while one runs is joined (startArrJob), never sent twice.
  const key = ["provider-save", target.service, target.instance, kind, id, JSON.stringify(change), acceptWarnings === true].join("\u0000");
  const { jobId } = startArrJob(owner, key, async () => answerOf(await save()));
  return NextResponse.json({ job: jobId }, { status: 202 });
});
