import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { arrFailure, arrGate, parseArrId } from "@/lib/arr-admin-http";
import { parseProviderKind } from "@/lib/arr-system";
import { testProviders } from "@/lib/arr-system-data";
import { readJsonCapped } from "@/lib/body-size";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { checkRateLimit } from "@/lib/rate-limit";

const LIMIT_PER_MIN = 6;

// Admin → Arr System → Indexers & clients, "Test" (ADMIN).
//   POST { service, instance, kind: "indexer" | "downloadClient", id? } →
//   { results: [{ id, ok, messages }] } — the arr's Test All for the kind, or
//   one provider by id (read from the arr and sent back to its test endpoint
//   server-side; its credentials never leave the server). Messages are the
//   arr's own, credentials masked. Changes nothing, so not audited;
//   rate-limited per admin (each test calls out to every indexer/client).
export const POST = withAdmin(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  const parsed = await readJsonCapped<Record<string, unknown>>(req, 4 * 1024);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  const target = await arrGate(body.service, body.instance, t);
  if (target instanceof NextResponse) return target;
  const kind = parseProviderKind(body.kind);
  const id = body.id === undefined || body.id === null ? null : parseArrId(body.id);
  if (!kind || (body.id !== undefined && body.id !== null && (id === null || typeof body.id !== "number"))) {
    return NextResponse.json({ error: t("apiAdmin.arr.providerBodyInvalid") }, { status: 400 });
  }
  if (!checkRateLimit(`arr-provider-test:${session.user.id}`, LIMIT_PER_MIN, 60_000)) {
    return NextResponse.json({ error: t("apiUser.common.tooManyRequestsLater") }, { status: 429 });
  }
  try {
    return NextResponse.json({ results: await testProviders(target.service, target.instance, kind, id) });
  } catch (err) {
    return arrFailure(err, target, t, `${kind} test`);
  }
});
