// A Setting findMany that selects `value` without `key` hands the Prisma
// extension rows it can't name: safeDecryptSettingValue then tries to decrypt
// every value (plaintext URLs, flags, timestamps included) and logs
// "[token-crypto] Legacy plaintext value observed for Setting.?" — a warning
// naming no row an operator could re-save. Seen in a production log from
// tmdb-localize's contentLocaleSeen:* read (2026-10-13). A findUnique/findFirst
// is named by its plain `where.key` (settingKeyFromArgs); a findMany can only be
// named by its rows, so it must select the key.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../src/", import.meta.url).pathname;

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === "generated") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (/\.(ts|tsx)$/.test(name)) yield p;
  }
}

/** The argument text of each `.setting.findMany(…)` call, balanced on parentheses. */
function findManyArgs(src: string): string[] {
  const out: string[] = [];
  const re = /\.setting\.findMany\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let depth = 1;
    let j = m.index + m[0].length;
    while (depth > 0 && j < src.length) {
      if (src[j] === "(") depth++;
      else if (src[j] === ")") depth--;
      j++;
    }
    out.push(src.slice(m.index + m[0].length, j - 1));
  }
  return out;
}

test("every Setting findMany that narrows its select also selects the key", () => {
  const offenders: string[] = [];
  let seen = 0;
  for (const file of files(ROOT)) {
    for (const arg of findManyArgs(readFileSync(file, "utf8"))) {
      seen++;
      if (/\bselect\s*:/.test(arg) && !/\bkey\s*:\s*true\b/.test(arg)) offenders.push(`${file.replace(ROOT, "src/")}: ${arg.replace(/\s+/g, " ").slice(0, 120)}`);
    }
  }
  assert.ok(seen > 10, "the scan found the repo's findMany calls");
  assert.deepEqual(offenders, []);
});

test("the scan itself catches the shape that logged Setting.?", () => {
  const bad = `prisma.setting.findMany({ where: { key: { startsWith: "x:" } }, select: { value: true } })`;
  const args = findManyArgs(bad);
  assert.equal(args.length, 1);
  assert.ok(/\bselect\s*:/.test(args[0]) && !/\bkey\s*:\s*true\b/.test(args[0]));
});
