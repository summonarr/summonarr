// The MDBList reserve only works if every cron's MDBList call says it is a
// background job. A bare call is a "page" and may spend the day down to zero,
// and For You's "are the providers answering?" check then reads MDBList as up
// after it stopped asking — stamping week-long null verdicts (the 2026-10-28
// failure). This scans the three cron callers and requires the flag on every
// call that reaches MDBList, so a dropped option fails here instead of in prod.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");

// The source with line comments removed (a comment can name a function).
function code(file: string): string {
  return readFileSync(join(ROOT, file), "utf8")
    .split("\n")
    .map((line) => line.replace(/(^|\s)\/\/.*$/, "$1"))
    .join("\n");
}

// Every call of `name(...)` with its full argument text, parentheses balanced.
function calls(src: string, name: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`\\b${name}\\(`, "g");
  for (let m = re.exec(src); m; m = re.exec(src)) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < src.length && depth > 0) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") depth--;
      i++;
    }
    out.push(src.slice(start, i - 1));
  }
  return out;
}

const BACKGROUND = /\bBACKGROUND\w*\b|background:\s*true/;

const CALLERS: Array<{ file: string; fns: string[] }> = [
  { file: "src/lib/recommendation-graph.ts", fns: ["attachRatingsUnified", "isMdblistQuotaLocked", "fetchMdblistBatch", "mdblistPause", "checkMdblistPause"] },
  { file: "src/lib/mdblist-prewarm.ts", fns: ["fetchMdblistBatch", "isMdblistQuotaLocked", "mdblistPause", "checkMdblistPause"] },
  {
    file: "src/app/api/sync/ratings/route.ts",
    fns: ["fetchMdblistBatch", "revalidateMdblistForTmdb", "fetchUnifiedRatings", "getMdblistRatingsForTmdb", "isMdblistQuotaLocked", "mdblistPause", "checkMdblistPause"],
  },
];

for (const { file, fns } of CALLERS) {
  test(`${file}: every MDBList call is marked as a background job`, () => {
    const src = code(file);
    let seen = 0;
    for (const fn of fns) {
      for (const args of calls(src, fn)) {
        seen++;
        assert.match(args, BACKGROUND, `${fn}(${args.trim().slice(0, 80)}) in ${file} must pass the background flag`);
      }
    }
    assert.ok(seen > 0, `the scan found no MDBList calls in ${file} — the scan is broken, not the file`);
  });
}

test("For You's 'providers answering' check reads MDBList as a background caller", () => {
  const src = code("src/lib/recommendation-graph.ts");
  assert.match(src, /providersAnswering\s*=\s*!isMdblistQuotaLocked\(BACKGROUND_RATINGS\)/);
});
