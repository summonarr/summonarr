import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { arrFailure, arrGate, parseArrId } from "@/lib/arr-admin-http";
import { parseProviderEnableChange, parseProviderKind } from "@/lib/arr-system";
import { loadProviders, setProviderEnabled } from "@/lib/arr-system-data";
import { auditContext, logAudit } from "@/lib/audit";
import { readJsonCapped } from "@/lib/body-size";
import { translatorForRequest } from "@/lib/i18n/server-locale";

// Admin → Arr System → Indexers & clients (ADMIN).
//   GET → { instances, errors, results: [{ service, instance, indexers, downloadClients }] }:
//       every configured instance's indexers (protocol, priority, which uses
//       are on, and whether the arr has disabled one after failures) and
//       download clients. Never their settings — those hold API keys, passkeys
//       and passwords.
//   PATCH { service, instance, kind: "indexer", id, enableRss?, enableAutomaticSearch?, enableInteractiveSearch? }
//   PATCH { service, instance, kind: "downloadClient", id, enable } — switch
//       them. The arr's own resource is read and saved back with only those
//       flags changed, server-side. Switching one ON lets the arr test it — a
//       failing test is 400 with its (masked) reason; a change that only turns
//       things off is saved without the test (forceSave). → the provider as
//       saved. Audited ARR_PROVIDER_CHANGE after the arr accepted it.
export const GET = withAdmin(async () => {
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
  if (!kind || id === null || typeof body.id !== "number" || !change) {
    return NextResponse.json({ error: t("apiAdmin.arr.providerBodyInvalid") }, { status: 400 });
  }
  let provider;
  try {
    provider = await setProviderEnabled(target.service, target.instance, kind, id, change);
  } catch (err) {
    return arrFailure(err, target, t, `${kind} change`);
  }
  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email ?? null,
    action: "ARR_PROVIDER_CHANGE",
    target: `${target.service}:${target.instance}:${kind}:${id}`,
    details: { service: target.service, instance: target.instance, kind, id, name: provider.name, change },
    ...auditContext(req, session),
  });
  return NextResponse.json({ provider });
});
