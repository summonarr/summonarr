import { test } from "node:test";
import assert from "node:assert/strict";
import { hasUseClientDirective } from "./_use-client.mts";

test("a directive is found after whitespace and comments, and nowhere else", () => {
  assert.equal(hasUseClientDirective('"use client";\nexport {};'), true);
  assert.equal(hasUseClientDirective("'use client'\n"), true);
  assert.equal(hasUseClientDirective('// note\n/* block\n   comment */\n\n"use client";'), true);
  assert.equal(hasUseClientDirective('import x from "y";\n"use client";'), false);
  assert.equal(hasUseClientDirective('/* never closed\n"use client";'), false);
  assert.equal(hasUseClientDirective('// only a comment, no newline "use client"'), false);
});

test("a very long unterminated comment is rejected without backtracking", () => {
  const started = Date.now();
  assert.equal(hasUseClientDirective("/*" + "a".repeat(2_000_000)), false);
  assert.ok(Date.now() - started < 1000);
});
