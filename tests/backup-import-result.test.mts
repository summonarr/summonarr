// The admin backup restore page (src/components/admin/backup-ui.tsx) and the
// reading of its completion body (src/components/admin/backup-import-result.ts).
//
//   - The body's summary reaches the KPI grid only with every count a number: a
//     missing one crashed the section on `value.toLocaleString`.
//   - A new file (picked or dropped) closes an open confirmation: confirming
//     file A then dropping B left "Yes, restore" armed for B.
//   - Only the current file's header check lands: a slow check of a replaced
//     file overwrote the new one's verdict.
//   - "Yes, restore" is enabled only once the header check said "encrypted".
//   - An upload still sending chunks can be cancelled.
// Structural pins for the .tsx (the runner can't render it).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { importResultFrom } from "../src/components/admin/backup-import-result.ts";

const src = readFileSync(new URL("../src/components/admin/backup-ui.tsx", import.meta.url), "utf8");
const fn = (name: string, next: string) => src.slice(src.indexOf(name), src.indexOf(next, src.indexOf(name)));

test("a completed restore's body: each field kept only in its shape", () => {
  assert.deepEqual(
    importResultFrom({ ok: true, complete: true, summary: { total: 3, executed: 2, skipped: 1, errors: 0, conflicts: {} }, warning: "Reload" }),
    { ok: true, summary: { total: 3, executed: 2, skipped: 1, errors: 0 }, warning: "Reload" },
  );
  assert.deepEqual(importResultFrom({ ok: false, summary: { total: 3, executed: 2, skipped: 1 }, errors: ["bad row", 7, null] }), {
    ok: false,
    errors: ["bad row"],
  }, "a summary missing a count is dropped; non-string errors are dropped");
  assert.deepEqual(importResultFrom({ ok: "yes", warning: "" }), { ok: false });
});

test("a new file starts over: no open confirmation, its size at once, and only its own header check lands", () => {
  const change = fn("async function handleFileChange(", "async function handleImport(");
  assert.match(change, /const seq = \+\+fileSeq\.current;/);
  assert.match(change, /setConfirming\(false\);/);
  assert.match(change, /setSizeBytes\(f \? f\.size : null\);/);
  assert.match(change, /if \(seq === fileSeq\.current\) setEncrypted\(isEnc\);/);
  assert.match(change, /if \(seq === fileSeq\.current\) setResult\(/);
  assert.match(fn("function clearFile(", "return {"), /fileSeq\.current\+\+;/, "Clear drops a check in flight too");
});

test("'Yes, restore' waits for a passed header check, and an upload can be cancelled", () => {
  const confirm = fn("function ConfirmRestore(", "function UploadProgress(");
  assert.match(confirm, /disabled=\{importing \|\| encrypted !== true\}/);
  const progress = fn("function UploadProgress(", "function ImportSummaryPanel(");
  assert.match(progress, /\{progress\.phase === "upload" && \(/, "only while chunks are still going out");
  assert.match(progress, /onClick=\{onCancel\}/);
  assert.match(fn("function cancelUpload(", "function clearFile("), /uploadAbortRef\.current\?\.abort\(\);/);
  assert.match(src, /setResult\(importResultFrom\(outcome\.data\)\);/);
});
