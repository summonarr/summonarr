// The client half of the background fix-match (guardrail 37a) hands its
// consumers CODES, never English prose: both the per-row FixMatchButton and
// the issue dialog map a code to a translated line through one shared helper,
// so a French admin never sees the restart/timeout guidance in English. The
// poll loop itself (3s interval, 20 min deadline) is not driven here — these
// pin the pure mapping and, structurally, that the lib has no bare `Error`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  FixMatchClientError,
  fixMatchErrorMessage,
  fixMatchWarningMessage,
} from "../src/lib/client/fix-match.ts";
import type { Translator } from "../src/lib/i18n/translate.ts";

// Records the key + vars it was asked for so a test can assert the mapping
// without a catalog.
const t: Translator = (key, vars) => `<${key}${vars ? ":" + JSON.stringify(vars) : ""}>`;

test("every client-only outcome maps to its own translation key", () => {
  assert.equal(fixMatchErrorMessage(new FixMatchClientError("jobLost", { status: 404 }), t), "<adminQueue.fixMatch.outcome.jobLost>");
  assert.equal(fixMatchErrorMessage(new FixMatchClientError("pollLost"), t), "<adminQueue.fixMatch.outcome.pollLost>");
  assert.equal(fixMatchErrorMessage(new FixMatchClientError("pollLost", { status: 502 }), t), "<adminQueue.fixMatch.outcome.pollLost>");
  assert.equal(fixMatchErrorMessage(new FixMatchClientError("timedOut"), t), "<adminQueue.fixMatch.outcome.timedOut>");
});

test("an HTTP failure with no server message reports the status through the shared key", () => {
  assert.equal(
    fixMatchErrorMessage(new FixMatchClientError("http", { status: 503 }), t),
    '<adminQueue.common.requestFailed:{"status":503}>',
  );
});

test("`failed` passes the server's (already translated) message through verbatim, falling back to a key when it sent none", () => {
  const serverMsg = "Jellyfin a refusé l'identification";
  assert.equal(fixMatchErrorMessage(new FixMatchClientError("failed", { message: serverMsg }), t), serverMsg);
  assert.equal(fixMatchErrorMessage(new FixMatchClientError("failed", { message: "" }), t), "<adminQueue.fixMatch.outcome.failed>");
});

test("a non-client error keeps its own message; anything else is the unknown-error key", () => {
  assert.equal(fixMatchErrorMessage(new Error("boom"), t), "boom");
  assert.equal(fixMatchErrorMessage("nope", t), "<adminQueue.fixMatch.unknownError>");
  assert.equal(fixMatchErrorMessage(new Error(""), t), "<adminQueue.fixMatch.unknownError>");
});

test("a successful outcome's warning line: server note, joined notice, both, or nothing", () => {
  assert.equal(fixMatchWarningMessage({ ok: true }, t), null);
  assert.equal(fixMatchWarningMessage({ ok: true, warning: "2 of 3 copies" }, t), "2 of 3 copies");
  assert.equal(fixMatchWarningMessage({ ok: true, joined: true }, t), "<adminQueue.fixMatch.outcome.joined>");
  assert.equal(
    fixMatchWarningMessage({ ok: true, warning: "2 of 3 copies", joined: true }, t),
    "2 of 3 copies <adminQueue.fixMatch.outcome.joined>",
  );
});

test("structural: the client lib throws only FixMatchClientError — never a bare Error carrying prose", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "../src/lib/client/fix-match.ts"), "utf8");
  // Reverting any of the five old `throw new Error("The server lost track…")`
  // sites fails this pin.
  assert.equal(src.match(/throw new Error\(/g), null, "bare `throw new Error(` found in src/lib/client/fix-match.ts");
  // Every code the type names is constructible, so a consumer switch stays total.
  for (const code of ["http", "failed", "jobLost", "pollLost", "timedOut"] as const) {
    const err = new FixMatchClientError(code);
    assert.equal(err.code, code);
    assert.ok(err instanceof Error);
  }
});
