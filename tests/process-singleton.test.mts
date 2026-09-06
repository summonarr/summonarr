// Unit tests for src/lib/process-singleton.ts.
//
// Turbopack inlines a lib module into every server chunk that imports it, so
// module-level state is per-CHUNK, not per-process. Measured on a production
// build of this app: src/lib/token-crypto.ts compiled into 10 server chunks and
// src/lib/prisma.ts into 4, each with its own copy of the Set it used to dedupe
// warnings. That is why an operator saw the same "Legacy plaintext value
// observed for Setting.mdblistApiKey" line more than once from a helper named
// warnLegacyPlaintextOnce: it warned once per chunk.
//
// The load-bearing property is the second test: two SEPARATE evaluations of the
// same module (the closest a unit test gets to two chunks) must observe one
// shared object. A plain `const x = new Set()` fails exactly that.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  processSingleton,
  __resetProcessSingletonForTests,
} from "../src/lib/process-singleton.ts";

test("the first caller creates the value and later callers get that same object", () => {
  __resetProcessSingletonForTests("t:basic");
  let created = 0;
  const a = processSingleton("t:basic", () => { created++; return new Set<string>(); });
  a.add("x");
  const b = processSingleton("t:basic", () => { created++; return new Set<string>(); });

  assert.equal(created, 1, "the factory runs at most once per process");
  assert.equal(a, b, "same reference, so a module-scope const stays valid");
  assert.ok(b.has("x"), "state written through one handle is visible through the other");
});

test("a second evaluation of the same module shares the first one's state", async () => {
  __resetProcessSingletonForTests("t:cross-instance");

  // A cache-busting query string forces Node to evaluate the module AGAIN,
  // producing a distinct instance with its own module scope — the unit-test
  // analogue of the same lib landing in two server chunks.
  // Held in a variable, not a literal: a query-string specifier is meaningless to
  // the type checker (TS2307) even though the loader resolves it fine at runtime.
  const secondInstanceSpecifier = "../src/lib/process-singleton.ts?instance=2";
  const first = await import("../src/lib/process-singleton.ts");
  const second: typeof first = await import(secondInstanceSpecifier);
  assert.notEqual(first, second, "the two imports must be distinct module instances");

  const setA = first.processSingleton("t:cross-instance", () => new Set<string>());
  setA.add("from-instance-1");
  const setB = second.processSingleton("t:cross-instance", () => new Set<string>());

  assert.equal(
    setB.has("from-instance-1"),
    true,
    "a second module instance must see the first instance's state — this is the whole point",
  );
  assert.equal(setA, setB, "and it must be literally the same object");
});

test("distinct keys never collide", () => {
  __resetProcessSingletonForTests("t:k1");
  __resetProcessSingletonForTests("t:k2");
  const one = processSingleton("t:k1", () => new Map<string, number>());
  const two = processSingleton("t:k2", () => new Map<string, number>());
  one.set("a", 1);
  assert.equal(two.size, 0, "one namespace's writes must not reach another's");
  assert.notEqual(one, two);
});

test("the registry survives on a shared symbol, not a module-scoped binding", () => {
  __resetProcessSingletonForTests("t:sym");
  processSingleton("t:sym", () => new Set<string>(["seeded"]));
  // Symbol.for is cross-realm-stable by construction; reading it back the way a
  // different chunk would proves the state is not hidden in module scope.
  const holder = globalThis as unknown as Record<symbol, Map<string, unknown> | undefined>;
  const reg = holder[Symbol.for("summonarr.processSingletons")];
  assert.ok(reg instanceof Map, "the registry hangs off globalThis under a well-known symbol");
  assert.ok((reg.get("t:sym") as Set<string>).has("seeded"));
});

test("the reset seam drops only its own key", () => {
  __resetProcessSingletonForTests("t:r1");
  __resetProcessSingletonForTests("t:r2");
  processSingleton("t:r1", () => new Set<string>(["a"]));
  processSingleton("t:r2", () => new Set<string>(["b"]));

  __resetProcessSingletonForTests("t:r1");
  const r1 = processSingleton("t:r1", () => new Set<string>());
  const r2 = processSingleton("t:r2", () => new Set<string>());
  assert.equal(r1.size, 0, "the reset key is rebuilt fresh");
  assert.ok(r2.has("b"), "its neighbour is untouched");
});
