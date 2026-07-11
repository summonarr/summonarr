// Unit tests for the backup table manifest (src/lib/backup-schema.ts). The
// comment in that file says "Keep this in sync with prisma/schema.prisma" —
// this test makes that a CI failure instead of a code comment: a model added
// to the schema but not to BACKUP_TABLES would silently ship backups that
// TRUNCATE-fail (FK from an unlisted table) or omit data on restore.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  BACKUP_TABLES,
  BACKUP_ENUMS,
  computeSchemaFingerprint,
} from "../src/lib/backup-schema.ts";

const schema = readFileSync(join(process.cwd(), "prisma", "schema.prisma"), "utf-8");
const schemaModels = [...schema.matchAll(/^model\s+(\w+)/gm)].map((m) => m[1]);
const schemaEnums = [...schema.matchAll(/^enum\s+(\w+)/gm)].map((m) => m[1]);

test("BACKUP_TABLES covers every Prisma model — and nothing else", () => {
  const listed = new Set<string>(BACKUP_TABLES);
  const inSchema = new Set(schemaModels);
  for (const model of inSchema) {
    assert.equal(listed.has(model), true, `model "${model}" is in schema.prisma but missing from BACKUP_TABLES`);
  }
  for (const table of listed) {
    assert.equal(inSchema.has(table), true, `"${table}" is in BACKUP_TABLES but not a model in schema.prisma`);
  }
});

test("BACKUP_ENUMS covers every Prisma enum — and nothing else", () => {
  const listed = new Set<string>(BACKUP_ENUMS);
  const inSchema = new Set(schemaEnums);
  for (const e of inSchema) {
    assert.equal(listed.has(e), true, `enum "${e}" is in schema.prisma but missing from BACKUP_ENUMS`);
  }
  for (const e of listed) {
    assert.equal(inSchema.has(e), true, `"${e}" is in BACKUP_ENUMS but not an enum in schema.prisma`);
  }
});

test("no duplicate entries in either list", () => {
  assert.equal(new Set<string>(BACKUP_TABLES).size, BACKUP_TABLES.length);
  assert.equal(new Set<string>(BACKUP_ENUMS).size, BACKUP_ENUMS.length);
});

test("FK ordering spot-checks: parents precede children", () => {
  const idx = (name: (typeof BACKUP_TABLES)[number]) => BACKUP_TABLES.indexOf(name);
  assert.ok(idx("User") < idx("Account"), "User must precede Account");
  assert.ok(idx("User") < idx("MediaRequest"), "User must precede MediaRequest");
  assert.ok(idx("Issue") < idx("IssueMessage"), "Issue must precede IssueMessage");
  assert.ok(idx("MediaServerUser") < idx("PlayHistory"), "MediaServerUser must precede PlayHistory");
  assert.ok(idx("MediaServerUser") < idx("ActiveSession"), "MediaServerUser must precede ActiveSession");
});

test("schema fingerprint: 16 hex chars, cached-stable, matches the file bytes", () => {
  const fp = computeSchemaFingerprint();
  assert.match(fp, /^[0-9a-f]{16}$/);
  assert.equal(computeSchemaFingerprint(), fp);
  // Independent recomputation: the fingerprint gates restore-vs-TRUNCATE, so
  // pin the exact algorithm (sha256 of the utf-8 file contents, first 16 hex
  // chars) rather than trusting the module to agree with itself. A silent
  // algorithm change would make every existing backup unrestorable.
  const expected = createHash("sha256").update(schema).digest("hex").slice(0, 16);
  assert.equal(fp, expected);
});

test("FK ordering, full invariant: every relation's parent precedes its child in BACKUP_TABLES", () => {
  // Derive parent→child edges straight from prisma/schema.prisma: inside each
  // model block, a field carrying `@relation(... fields: [...] ...)` is the FK
  // side, and that field's type is the referenced parent model. The import
  // replays INSERTs in BACKUP_TABLES order with constraints live, so every
  // parent must come first — the hardcoded spot-checks above cover only 5 of
  // these edges; this covers all of them, including ones added later.
  const modelBlocks = [...schema.matchAll(/^model\s+(\w+)\s+\{([\s\S]*?)^\}/gm)];
  assert.ok(modelBlocks.length > 0, "failed to parse any model blocks from schema.prisma");

  const idx = new Map<string, number>(BACKUP_TABLES.map((t, i) => [t, i]));
  let edges = 0;
  for (const [, child, body] of modelBlocks) {
    for (const line of body.split("\n")) {
      // FK-side declaration: `<field> <ParentModel>? @relation(..., fields: [...], ...)`.
      // Every @relation attribute in this schema is single-line (verified);
      // the list side (`Issue[]`) never carries `fields:` so it never matches.
      const m = line.match(/^\s*\w+\s+(\w+)\??\s+.*@relation\([^)]*\bfields\s*:/);
      if (!m) continue;
      const parent = m[1];
      if (parent === child) continue; // self-relation: no ordering constraint possible
      edges++;
      const parentIdx = idx.get(parent);
      const childIdx = idx.get(child);
      assert.notEqual(parentIdx, undefined, `relation parent "${parent}" (of "${child}") missing from BACKUP_TABLES`);
      assert.notEqual(childIdx, undefined, `relation child "${child}" missing from BACKUP_TABLES`);
      assert.ok(
        (parentIdx as number) < (childIdx as number),
        `"${parent}" must precede "${child}" in BACKUP_TABLES (FK ${child} → ${parent})`,
      );
    }
  }
  // Guard against the regex silently matching nothing and vacuously passing —
  // the schema has ~20 FK relations today.
  assert.ok(edges >= 10, `expected to derive at least 10 FK edges from the schema, got ${edges}`);
});

test("no @@map on any model: model name must equal the physical table name", () => {
  // backup-import.ts uses BACKUP_TABLES entries verbatim as quoted Postgres
  // identifiers — `"public"."<Model>"` in the TRUNCATE (line ~555) and in the
  // INSERT allowlist regex — and db-export writes INSERTs the same way. An
  // @@map on a backed-up model would rename the physical table out from under
  // both while the model-name↔BACKUP_TABLES test above stayed green.
  assert.equal(schema.includes("@@map("), false, "schema.prisma contains @@map( — backup TRUNCATE/INSERT identifiers assume model name == table name");
});
