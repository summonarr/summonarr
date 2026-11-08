// Library cleanup takes titles off an instance like the title manager's Remove,
// so it drops their kept title-manager views too (guardrail 5h): a removed
// title's views would otherwise 404 on every background re-read.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const CODE = readFileSync(join(ROOT, "src/lib/library-cleanup-execute.ts"), "utf8")
  .split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");

test("cleanup drops a deleted title's snapshot views on success AND on 'gone already' (404)", () => {
  assert.match(CODE, /import \{ dropArrTitleSnapshots \} from "\.\/arr-snapshot"/);
  assert.match(CODE, /dropArrTitleSnapshots\(\{ service: t\.service, instance: t\.instance, arrId: t\.arrId, tmdbId \}\)/);
  // One site, after the delete's try: a success and a 404 both reach it, any
  // other failure `continue`s before it — and a drop that throws can't be
  // taken for a failed delete (tests/library-cleanup-routes.test.mts drives it).
  assert.match(CODE, /await deleteArrEntry\(t\);\s*\} catch \(err\) \{\s*if \(!\(err instanceof ArrResponseError && err\.status === 404\)\) \{[\s\S]*?continue;\s*\}\s*\}\s*outcome\.deleted\.push\(targetLabel\(t\)\);\s*dropSnapshots\(t, row\.tmdbId\);/);
});
