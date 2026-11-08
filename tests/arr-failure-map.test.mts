// arrFailure (src/lib/arr-admin-http.ts) maps every data-layer error the admin
// Radarr/Sonarr routes raise to ONE status and message. Each case pins the
// status and the English text, so a reordered or dropped rule fails here.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.TOKEN_ENCRYPTION_KEY ??= "ab".repeat(32);
process.env.NEXTAUTH_SECRET ??= "arr-failure-map-test-secret-0123456789ab";

const { arrFailure } = await import("../src/lib/arr-admin-http.ts");
const { ArrItemNotFoundError, ArrResponseError } = await import("../src/lib/arr.ts");
const { ArrInstanceError } = await import("../src/lib/arr-admin.ts");
const { TitleEditError } = await import("../src/lib/arr-title.ts");
const { AlreadyFailedError, MarkInProgressError, NotAGrabError, NotOnTitleError, TitleNotFoundError } = await import("../src/lib/arr-title-data.ts");
const { BlocklistGoneError } = await import("../src/lib/arr-history-data.ts");
const { CommandNotQueuedError, ProviderNotFoundError, ProviderRejectedError, UnknownTaskError } = await import("../src/lib/arr-system-data.ts");
const { translatorFor } = await import("../src/lib/i18n/server-locale.ts");

const t = translatorFor("en");
const target = { service: "radarr" as const, instance: "" };
const svc = { service: "Radarr" };

const cases: Array<[string, unknown, number, string, string[] | undefined]> = [
  ["unknown instance", new ArrInstanceError(), 404, t("apiAdmin.missing.instanceUnknown", svc), undefined],
  ["title not found", new TitleNotFoundError(), 404, t("apiAdmin.arr.titleNotFound", svc), undefined],
  ["item gone from the arr", new ArrItemNotFoundError(), 409, t("apiUser.requests.releases.notInArr", svc), undefined],
  ["not on title", new NotOnTitleError("file"), 409, t("apiAdmin.arr.notOnTitle.file"), undefined],
  ["not a grab", new NotAGrabError(), 409, t("apiAdmin.arr.notAGrab"), undefined],
  ["mark in progress", new MarkInProgressError(), 409, t("apiAdmin.arr.markInProgress"), undefined],
  ["already failed", new AlreadyFailedError(), 409, t("apiAdmin.arr.alreadyFailed"), undefined],
  ["blocklist gone", new BlocklistGoneError(), 409, t("apiAdmin.arr.blocklistGone"), undefined],
  ["edit refused", new TitleEditError("qualityProfileId" as never), 400, t("apiAdmin.arr.edit.qualityProfileId", svc), undefined],
  ["unknown task", new UnknownTaskError(), 400, t("apiAdmin.arr.unknownTask", svc), undefined],
  ["command not queued", new CommandNotQueuedError(), 409, t("apiAdmin.arr.commandNotQueued"), undefined],
  ["provider not found", new ProviderNotFoundError(), 404, t("apiAdmin.arr.providerNotFound", svc), undefined],
  ["provider rejected", new ProviderRejectedError(["Bad host"]), 400, t("apiAdmin.arr.rejected", { ...svc, reason: "Bad host" }), ["Bad host"]],
  ["provider rejected, no reason", new ProviderRejectedError([]), 400, t("apiAdmin.arr.rejected", { ...svc, reason: t("apiAdmin.arr.noReason") }), []],
  ["arr 400", new ArrResponseError(400, JSON.stringify([{ errorMessage: "Path is invalid" }])), 400, t("apiAdmin.arr.rejected", { ...svc, reason: "Path is invalid" }), ["Path is invalid"]],
  ["arr 409", new ArrResponseError(409, JSON.stringify({ message: "Unable to cancel task" })), 409, t("apiAdmin.arr.rejected", { ...svc, reason: "Unable to cancel task" }), ["Unable to cancel task"]],
  ["arr 404", new ArrResponseError(404, ""), 404, t("apiAdmin.arr.goneUpstream", svc), undefined],
  ["arr 401", new ArrResponseError(401, ""), 502, t("apiAdmin.arr.failedAuth", svc), undefined],
  ["arr 500", new ArrResponseError(500, ""), 502, t("apiAdmin.arr.failedServer", svc), undefined],
  ["anything else", new Error("boom"), 502, t("apiAdmin.arr.failed", svc), undefined],
];

test("arrFailure answers each data-layer error with its own status and message", async () => {
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    for (const [name, err, status, error, messages] of cases) {
      const res = arrFailure(err, target, t, "test");
      assert.equal(res.status, status, name);
      const body = (await res.json()) as { error: string; messages?: string[] };
      assert.equal(body.error, error, name);
      assert.deepEqual(body.messages, messages, name);
    }
  } finally {
    console.warn = realWarn;
  }
});
