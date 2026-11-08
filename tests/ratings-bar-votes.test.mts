// RatingsBar's IMDb vote count ("(1.2M)", "(840K)"). The component is a "use
// client" .tsx module the loader can't import, so the one pure helper is cut
// out of the source and run on its own (the report-issue-manual-inputs idiom).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript") as typeof import("typescript");
const source = readFileSync(new URL("../src/components/media/ratings-bar.tsx", import.meta.url), "utf8");
const m = /function formatVotes\([\s\S]*?\n\}\n/.exec(source);
assert.ok(m, "formatVotes must exist in ratings-bar.tsx");
const js = ts.transpileModule(m[0], { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const formatVotes = new Function(`${js}\nreturn formatVotes;`)() as (raw: string) => string;

test("counts that round up to a thousand thousands read as millions, never 1000K", () => {
  assert.equal(formatVotes("999,499"), "999K");
  assert.equal(formatVotes("999,500"), "1.0M");
  assert.equal(formatVotes("999,999"), "1.0M");
  assert.equal(formatVotes("1,000,000"), "1.0M");
});

test("thousands, plain counts and junk", () => {
  assert.equal(formatVotes("1,234"), "1K");
  assert.equal(formatVotes("840,100"), "840K");
  assert.equal(formatVotes("12"), "12");
  assert.equal(formatVotes("n/a"), "");
});
