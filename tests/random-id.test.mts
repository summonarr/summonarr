// crypto.randomUUID is undefined outside a secure context (plain HTTP on a LAN
// or local-only install), so calling it threw and Plex sign-in and connect never
// started. Client code takes its ids from randomUuid(), which falls back to
// getRandomValues there.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUuid } from "../src/lib/random-id.ts";

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("randomUuid returns a v4 UUID with crypto.randomUUID present", () => {
  assert.match(randomUuid(), V4);
});

test("randomUuid still returns a v4 UUID where crypto.randomUUID does not exist (an insecure context)", () => {
  const original = Object.getOwnPropertyDescriptor(crypto, "randomUUID");
  Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true, writable: true });
  try {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const id = randomUuid();
      assert.match(id, V4);
      seen.add(id);
    }
    assert.equal(seen.size, 200, "ids are random");
  } finally {
    if (original) Object.defineProperty(crypto, "randomUUID", original);
    else delete (crypto as { randomUUID?: unknown }).randomUUID;
  }
});

test("no browser code calls crypto.randomUUID directly", () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? (e.name === "generated" ? [] : walk(join(dir, e.name))) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : [],
    );
  const offenders = walk(join(process.cwd(), "src"))
    .filter((f) => !f.endsWith(join("lib", "random-id.ts")))
    .filter((f) => {
      const src = readFileSync(f, "utf-8");
      const browser = /^\s*["']use client["']/.test(src) || f.includes(join("lib", "client")) || f.endsWith("chunked-upload.ts");
      return browser && /crypto\.randomUUID\s*\(/.test(src);
    });
  assert.deepEqual(offenders, [], "use randomUuid() from src/lib/random-id.ts");
});
