// The full-database dump's table walk (src/lib/backup-export.ts): keyset pages
// for a table with a primary key, OFFSET pages for one without, the INSERT
// shape backup-import's allowlist pins, and a row count that says how far a
// dump got even when it stops part-way.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
const { dumpTable, escapeSQL, writeEnumTypes } = await import("../src/lib/backup-export.ts");
const { BACKUP_ENUMS } = await import("../src/lib/backup-schema.ts");

type Row = Record<string, unknown>;
// A raw-query client over one in-memory table, recording each statement.
function fakeTx(rows: Row[], pk: string[]) {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  return {
    statements,
    async $queryRawUnsafe<T>(sql: string, ...values: unknown[]): Promise<T> {
      statements.push({ sql, values });
      if (sql.includes("pg_index")) return pk.map((attname) => ({ attname })) as T;
      if (sql.includes("pg_enum")) return [{ enumlabel: "MOVIE" }, { enumlabel: "TV's" }] as T;
      const limit = Number(/LIMIT (\d+)/.exec(sql)?.[1]);
      const offset = /OFFSET (\d+)/.exec(sql);
      if (offset) return rows.slice(Number(offset[1]), Number(offset[1]) + limit) as T;
      if (sql.includes("WHERE")) return rows.filter((r) => String(r.id) > String(values[0])).slice(0, limit) as T;
      return rows.slice(0, limit) as T;
    },
  };
}

const rows = (n: number): Row[] => Array.from({ length: n }, (_, i) => ({ id: `r${String(i).padStart(5, "0")}`, n: i }));

test("a table with a primary key is read in keyset pages after the previous page's last key", async () => {
  const tx = fakeTx(rows(2_345), ["id"]);
  const out: string[] = [];
  let counted = 0;
  const total = await dumpTable(tx, "Thing", async (s) => { out.push(s); }, () => { counted++; });
  assert.equal(total, 2_345);
  assert.equal(counted, 2_345, "every row is counted as it is written");
  const pages = tx.statements.filter((s) => s.sql.startsWith("SELECT * FROM"));
  assert.equal(pages.length, 3);
  assert.doesNotMatch(pages[1].sql, /OFFSET/);
  assert.match(pages[1].sql, /WHERE \("id"\) > \(\$1\) ORDER BY "id" LIMIT 1000$/);
  assert.deepEqual(pages[1].values, ["r00999"]);
  assert.equal(out[0], `INSERT INTO "public"."Thing" ("id", "n") VALUES ('r00000', 0) ON CONFLICT DO NOTHING;\n`);
  assert.equal(out.at(-1), "-- Table: Thing (2345 rows)\n\n");
});

test("a table with no primary key is read in OFFSET pages in ctid order", async () => {
  const tx = fakeTx(rows(1_500), []);
  assert.equal(await dumpTable(tx, "Token", async () => {}), 1_500);
  const pages = tx.statements.filter((s) => s.sql.startsWith("SELECT * FROM"));
  assert.deepEqual(pages.map((p) => /ORDER BY ctid LIMIT 1000 OFFSET (\d+)/.exec(p.sql)?.[1]), ["0", "1000"]);
});

test("an unsafe identifier is refused rather than written into the dump", async () => {
  await assert.rejects(dumpTable(fakeTx(rows(1), ['id"; DROP']), "Thing", async () => {}), /refusing unsafe PK column name/);
  await assert.rejects(dumpTable(fakeTx([{ "bad col": 1 }], []), "Thing", async () => {}), /refusing unsafe column name/);
});

test("a dump that stops part-way has counted every row it wrote", async () => {
  let counted = 0;
  let writes = 0;
  const failing = async () => {
    if (++writes === 1_500) throw new Error("reader went away");
  };
  await assert.rejects(dumpTable(fakeTx(rows(2_345), ["id"]), "Thing", failing, () => { counted++; }), /reader went away/);
  assert.equal(counted, 1_499);
});

test("enum types are written once each, quotes escaped", async () => {
  const out: string[] = [];
  await writeEnumTypes(fakeTx([], []), async (s) => { out.push(s); });
  assert.equal(out[0], "-- Enum types\n");
  assert.equal(out.length, BACKUP_ENUMS.length + 2);
  assert.match(out[1], /CREATE TYPE "\w+" AS ENUM \('MOVIE', 'TV''s'\)/);
});

test("escapeSQL writes each value as backup-import's literal allowlist reads it", () => {
  assert.equal(escapeSQL(null), "NULL");
  assert.equal(escapeSQL(undefined), "NULL");
  assert.equal(escapeSQL(true), "TRUE");
  assert.equal(escapeSQL(Number.NaN), "NULL");
  assert.equal(escapeSQL(12n), "12");
  assert.equal(escapeSQL(new Date(0)), "'1970-01-01T00:00:00.000Z'");
  assert.equal(escapeSQL([]), "'{}'");
  assert.equal(escapeSQL(["a", null, `b'"\\`]), `'{"a",NULL,"b''\\"\\\\"}'`);
  assert.equal(escapeSQL({ k: "it's" }), `'{"k":"it''s"}'`);
  assert.equal(escapeSQL("x\u0000y'z"), "'xy''z'");
});
