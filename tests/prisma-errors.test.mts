// Guardrail 23b: a Prisma error is identified by its `code`, never by
// `instanceof Prisma.*Error`. Inside the Next bundle the error's class can be
// another chunk's copy of the generated client (in `next dev` the client is
// cached on globalThis, so the first chunk to load created it), and instanceof
// is then false: POST /api/hidden twice answered 500 instead of its 409.
// A unit test shares one module instance and can't see that, so the rule is
// pinned as a scan of src/ plus the helper's own behaviour.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const { isPrismaErrorCode } = await import("../src/lib/prisma-errors.ts");
const { Prisma } = await import("../src/generated/prisma/index.js");

test("isPrismaErrorCode: matches a real Prisma error and the same error from another copy of the client; refuses look-alikes", () => {
  const real = new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "test" });
  assert.equal(isPrismaErrorCode(real, "P2002"), true);
  assert.equal(isPrismaErrorCode(real, "P2025"), false);
  // What another chunk's copy looks like to this one: same name and code, a
  // class this module never saw (instanceof would be false).
  class PrismaClientKnownRequestError extends Error {
    code = "P2034";
    constructor(m: string) { super(m); this.name = "PrismaClientKnownRequestError"; }
  }
  const foreign = new PrismaClientKnownRequestError("conflict");
  assert.equal(foreign instanceof Prisma.PrismaClientKnownRequestError, false);
  assert.equal(isPrismaErrorCode(foreign, "P2034"), true);
  // Fail closed: a look-alike that only carries the code is not a Prisma error.
  const lookAlike = Object.assign(new Error("unique violation"), { code: "P2002" });
  for (const v of [null, undefined, "P2002", 2002, {}, { code: "P2002" }, { code: 2002 }, new Error("P2002"), lookAlike]) {
    assert.equal(isPrismaErrorCode(v, "P2002"), false, `${String(v)} is not a P2002`);
  }
});

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (p === join("src", "generated")) continue;
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

test("no source file tests a Prisma error with instanceof or re-implements the code check (guardrail 23b)", () => {
  const files = walk("src");
  assert.ok(files.length > 100, "the walk found almost nothing — it is broken, not clean");
  const offenders: string[] = [];
  for (const f of files) {
    if (f.endsWith(join("lib", "prisma-errors.ts"))) continue;
    const src = readFileSync(f, "utf8").split("\n");
    src.forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return;
      if (/instanceof\s+(Prisma\.)?PrismaClient\w*Error/.test(line) || /\.code\s*===\s*["']P\d{4}["']/.test(line)) {
        offenders.push(`${f}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(offenders, [], "use isPrismaErrorCode(err, code) from src/lib/prisma-errors.ts");
});
