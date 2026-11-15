// What the permissions editor saved for a user, kept until the users page's
// re-read delivers it (src/components/admin/user-modals/saved-fields.ts). The
// editor sends whole values, so one reopened on the row's older copy would
// undo the save it just made with its next switch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createSavedFields } from "../src/components/admin/user-modals/saved-fields.ts";

type Row = { permissions: string; grants: Record<string, { request?: boolean }> };
const before: Row = { permissions: "1", grants: {} };
const after: Row = { permissions: "5", grants: { anime: { request: true } } };

test("a reopen before the page re-read starts from what was saved, not the row's older copy", () => {
  const saved = createSavedFields<Row>();
  saved.remember("u1", before, after);
  assert.deepEqual(saved.seed("u1", { permissions: "1", grants: {} }), after, "the row is still the replaced copy");
  assert.deepEqual(saved.seed("u1", { permissions: "1", grants: {} }), after, "and stays so on every reopen until it changes");
  assert.deepEqual(saved.seed("u2", before), before, "another user is untouched");
});

test("once the row changed, the row wins and the entry is gone", () => {
  const saved = createSavedFields<Row>();
  saved.remember("u1", before, after);
  // The re-read landed with someone else's later edit.
  const fresh: Row = { permissions: "9", grants: {} };
  assert.equal(saved.seed("u1", fresh), fresh);
  // The entry was dropped: a row that happens to match the old copy again is not overridden.
  assert.equal(saved.seed("u1", before), before);
});

test("a save that changed nothing remembers nothing, and clears an older entry", () => {
  const saved = createSavedFields<Row>();
  saved.remember("u1", before, after);
  saved.remember("u1", before, { permissions: "1", grants: {} });
  assert.equal(saved.seed("u1", before), before);
});

test("the store is bounded: the oldest entry leaves first", () => {
  const saved = createSavedFields<Row>(2);
  saved.remember("a", before, after);
  saved.remember("b", before, after);
  saved.remember("c", before, after);
  assert.equal(saved.seed("a", before), before, "evicted");
  assert.deepEqual(saved.seed("b", before), after);
  assert.deepEqual(saved.seed("c", before), after);
});

test("the permissions editor seeds every field and every FieldSave from the remembered values", () => {
  const src = readFileSync(new URL("../src/components/admin/user-modals/use-permission-edits.ts", import.meta.url), "utf8");
  assert.match(src, /const \[start\] = useState<EditedFields>\(\(\) => savedByUser\.seed\(u\.id, editedFields\(u\)\)\);/);
  assert.match(src, /createSavers\(start, /, "the savers' server-held baseline is the same start");
  const hook = src.slice(src.indexOf("export function usePermissionEdits("));
  assert.doesNotMatch(hook, /useState[^\n]*\(u\.(permissions|instanceGrants|mediaServerGrants|maxContentRating|movieQuota|tvQuota)/, "no field starts from the row prop");
  // Recorded against the row AS GIVEN, before the page is re-read.
  assert.match(hook, /savedByUser\.remember\(u\.id, editedFields\(u\), savedFields\(savers\(\)\)\);\s*router\.refresh\(\);/);
});
