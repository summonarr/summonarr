// Audit fix C067 (unit nw-ui): the Protect/Unprotect buttons on the
// never-watched report and on Library cleanup tracked their in-flight request
// with ONE busy key. Protecting row A then row B moved the key to B (A's
// button re-enabled mid-request), and A's `finally` then cleared it (B's
// button re-enabled mid-request) — a re-click sent a duplicate POST/DELETE, or
// the opposite operation once a reload had already flipped the row.
//
// The busy state is now a Set: each request adds its own key and its
// `finally` removes only that key. No .tsx renders under node:test, so this is
// a structural pin of both components' setProtected.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

const FILES = [
  "src/components/admin/never-watched-report.tsx",
  "src/components/admin/library-cleanup.tsx",
] as const;

/** The body of `async function setProtected(...) { … }`, brace-matched. */
function setProtectedBody(src: string): string {
  const start = src.indexOf("async function setProtected(");
  assert.ok(start >= 0, "setProtected not found");
  const open = src.indexOf("{", src.indexOf(")", start));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open + 1, i);
  }
  throw new Error("unbalanced setProtected");
}

/** The text of setProtected's `finally { … }` block. */
function finallyBlock(body: string): string {
  const at = body.lastIndexOf("finally {");
  assert.ok(at >= 0, "setProtected has no finally");
  const open = body.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < body.length; i++) {
    if (body[i] === "{") depth++;
    else if (body[i] === "}" && --depth === 0) return body.slice(open + 1, i);
  }
  throw new Error("unbalanced finally");
}

for (const file of FILES) {
  const src = read(file);

  test(`C067 ${file}: the busy state is a Set of keys, never a single key`, () => {
    assert.match(src, /const \[busyKeys, setBusyKeys\] = useState<Set<string>>\(/);
    assert.doesNotMatch(src, /\bsetBusyKey\(/, "the single-key setter is back");
    assert.doesNotMatch(src, /\bbusyKey\b/, "a single busy key is read");
    // Every read is a membership test — never an equality against one key.
    const reads = [...src.matchAll(/busyKeys(?!\])([.\s=!]+)/g)].map((m) => m[1]);
    assert.ok(reads.length > 0);
    for (const r of reads) assert.equal(r, ".", `busyKeys read as ${JSON.stringify(r)}`);
    assert.doesNotMatch(src, /busyKeys\s*[=!]==/);
  });

  test(`C067 ${file}: a request ADDS its key, keeping every other row's`, () => {
    const body = setProtectedBody(src);
    assert.match(body, /setBusyKeys\(\(prev\) => new Set\(prev\)\.add\(k\)\)/);
    // Replacing the set (`new Set([k])`) would re-enable the first row.
    assert.doesNotMatch(body, /setBusyKeys\(new Set\(/);
  });

  test(`C067 ${file}: the finally removes ONLY its own key`, () => {
    const fin = finallyBlock(setProtectedBody(src));
    assert.match(fin, /setBusyKeys\(\(prev\) => \{\s*const next = new Set\(prev\);\s*next\.delete\(k\);\s*return next;\s*\}\)/);
    assert.doesNotMatch(fin, /new Set\(\)/, "the finally empties every row's busy state");
    assert.doesNotMatch(fin, /\bnull\b/);
    assert.doesNotMatch(fin, /\.clear\(\)/);
  });
}
