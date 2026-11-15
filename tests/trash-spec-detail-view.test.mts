// The custom-format detail view's reading of a stored TRaSH payload
// (src/components/admin/trash-guides/spec-detail-view.ts). The payload is
// upstream JSON whose `specifications` elements nothing else checks, and the
// view renders them: every value must be a string, number or boolean by the
// time it reaches JSX, whatever arrived.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { customFormatDetailView } = await import("../src/components/admin/trash-guides/spec-detail-view.ts");
const { isCustomFormatPayload } = await import("../src/lib/trash-validators.ts");

test("a well-formed custom format reads through unchanged, with either fields shape", () => {
  const view = customFormatDetailView({
    trash_id: "abc",
    includeCustomFormatWhenRenaming: true,
    trash_scores: { default: 100, "sqp-1": -50 },
    specifications: [
      { name: "x265", implementation: "ReleaseTitleSpecification", negate: true, required: false, fields: { value: "\\bx265\\b" } },
      { name: "Bluray", implementation: "SourceSpecification", required: true, fields: [{ name: "other", value: 1 }, { name: "value", value: 9 }] },
      { name: "No fields", implementation: "Impl" },
    ],
  });
  assert.equal(view.trashId, "abc");
  assert.equal(view.includeWhenRenaming, true);
  assert.deepEqual(view.scores, [["default", 100], ["sqp-1", -50]]);
  assert.deepEqual(view.specs, [
    { name: "x265", implementation: "ReleaseTitleSpecification", negate: true, required: false, value: "\\bx265\\b" },
    { name: "Bluray", implementation: "SourceSpecification", negate: false, required: true, value: "9" },
    { name: "No fields", implementation: "Impl", negate: false, required: false, value: null },
  ]);
});

test("a malformed element costs that element or that field, and nothing renderable is an object", () => {
  const payload = {
    trash_id: "abc",
    name: "n",
    trash_scores: { default: 5 },
    specifications: [
      null,
      "loose",
      7,
      ["nested"],
      { name: { en: "object name" }, implementation: ["Impl"], negate: "yes", required: 1, fields: [null, "x", { name: "value", value: { min: 1 } }] },
      { name: "kept", implementation: "Impl", fields: "nope" },
      { name: "long", implementation: "Impl", fields: { value: "x".repeat(200) } },
    ],
  };
  // The refresh validator lets these through, so the view has to hold on its own.
  assert.equal(isCustomFormatPayload(payload), true);
  const view = customFormatDetailView(payload);
  assert.deepEqual(view.specs, [
    { name: "", implementation: "", negate: false, required: false, value: '{"min":1}' },
    { name: "kept", implementation: "Impl", negate: false, required: false, value: null },
    { name: "long", implementation: "Impl", negate: false, required: false, value: "x".repeat(60) },
  ]);
  for (const spec of view.specs) {
    for (const value of Object.values(spec)) assert.ok(value === null || typeof value !== "object", JSON.stringify(spec));
  }
});

test("the top-level fields are checked too, and a payload that is not an object reads as empty", () => {
  const view = customFormatDetailView({
    trash_id: { id: 1 },
    includeCustomFormatWhenRenaming: "true",
    trash_scores: { ok: 1, text: "5", obj: {}, inf: Infinity },
    specifications: { 0: { name: "not an array" } },
  });
  assert.deepEqual(view, { trashId: "", includeWhenRenaming: false, scores: [["ok", 1]], specs: [] });
  for (const junk of [null, undefined, "x", 3, []]) {
    assert.deepEqual(customFormatDetailView(junk), { trashId: "", includeWhenRenaming: false, scores: [], specs: [] });
  }
});

test("the detail component renders the checked view, not a cast of the payload", () => {
  const src = readFileSync(new URL("../src/components/admin/trash-guides/spec-section.tsx", import.meta.url), "utf8");
  const start = src.indexOf("function CustomFormatDetail(");
  const body = src.slice(start, src.indexOf("\nfunction ", start + 1));
  assert.match(body, /customFormatDetailView\(detail\.payload\)/);
  assert.doesNotMatch(body, /detail\.payload as/);
});
