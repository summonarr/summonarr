// Unit tests for subpath-deployment URL prefixing (src/lib/base-path.ts).
// NEXT_PUBLIC_BASE_PATH is read once at module load, so each configuration is
// loaded as a separate module instance via a cache-busting query-string import.
import { test } from "node:test";
import assert from "node:assert/strict";

type BasePathModule = typeof import("../src/lib/base-path.ts");

// Default instance: no base path configured.
delete process.env.NEXT_PUBLIC_BASE_PATH;
const bare = "../src/lib/base-path.ts";
const noBase = (await import(bare)) as BasePathModule;

// Second instance: configured with a trailing slash to exercise normalization.
process.env.NEXT_PUBLIC_BASE_PATH = "/request/";
const busted = "../src/lib/base-path.ts?base=request";
const withBase = (await import(busted)) as BasePathModule;

// Third instance: no leading slash — normalize() must prepend one, or every
// prefixed URL would ship as "request/api/…" (a relative path, wrong origin dir).
process.env.NEXT_PUBLIC_BASE_PATH = "request";
const slashless = "../src/lib/base-path.ts?base=slashless";
const addedLeading = (await import(slashless)) as BasePathModule;

// Fourth instance: bare "/" — must normalize to "" (no-op), not a "/" prefix
// that would double slashes on every generated URL ("//api/…" is protocol-relative).
process.env.NEXT_PUBLIC_BASE_PATH = "/";
const rootOnly = "../src/lib/base-path.ts?base=root";
const rootBase = (await import(rootOnly)) as BasePathModule;

test("unset BASE_PATH → empty constant, withBasePath is a no-op", () => {
  assert.equal(noBase.BASE_PATH, "");
  assert.equal(noBase.withBasePath("/api/requests"), "/api/requests");
  assert.equal(noBase.withBasePath("relative/path"), "relative/path");
});

test("configured BASE_PATH is normalized (leading slash kept, trailing slash dropped)", () => {
  assert.equal(withBase.BASE_PATH, "/request");
});

test("root-absolute paths get the prefix", () => {
  assert.equal(withBase.withBasePath("/api/requests"), "/request/api/requests");
  assert.equal(withBase.withBasePath("/sw.js"), "/request/sw.js");
});

test("fully-qualified and protocol-relative URLs pass through untouched", () => {
  assert.equal(withBase.withBasePath("https://example.com/x"), "https://example.com/x");
  assert.equal(withBase.withBasePath("data:image/png;base64,AAA"), "data:image/png;base64,AAA");
  assert.equal(withBase.withBasePath("//cdn.example.com/x"), "//cdn.example.com/x");
});

test("non-root-relative paths pass through untouched", () => {
  assert.equal(withBase.withBasePath("relative/path"), "relative/path");
  assert.equal(withBase.withBasePath(""), "");
});

test("slash-less env value gains a leading slash and still prefixes", () => {
  assert.equal(addedLeading.BASE_PATH, "/request");
  assert.equal(addedLeading.withBasePath("/api/x"), "/request/api/x");
});

test('NEXT_PUBLIC_BASE_PATH="/" normalizes to empty — withBasePath is a no-op', () => {
  assert.equal(rootBase.BASE_PATH, "");
  assert.equal(rootBase.withBasePath("/api/requests"), "/api/requests");
  assert.equal(rootBase.withBasePath("/"), "/");
});
