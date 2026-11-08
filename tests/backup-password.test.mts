// The BACKUP_DB_PASSWORD rule lives in one module (src/lib/backup-password.ts).
// It used to be copied into five backup routes and two pages, each with its own
// `MIN_BACKUP_PASSWORD_LEN = 12` or a bare `>= 12`, kept in step by hand: a
// change in one place would let a page call backup ready while a route refused,
// or the reverse.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  MIN_BACKUP_PASSWORD_LEN,
  backupPasswordStatus,
  isBackupPasswordReady,
} from "../src/lib/backup-password.ts";

const saved = process.env.BACKUP_DB_PASSWORD;
afterEach(() => {
  if (saved === undefined) delete process.env.BACKUP_DB_PASSWORD;
  else process.env.BACKUP_DB_PASSWORD = saved;
});

test("the floor is 12 characters: 11 is not ready, 12 is", () => {
  assert.equal(MIN_BACKUP_PASSWORD_LEN, 12);
  process.env.BACKUP_DB_PASSWORD = "12345678901";
  assert.equal(isBackupPasswordReady(), false);
  assert.deepEqual(backupPasswordStatus(), { ok: false, kind: "short" });
  process.env.BACKUP_DB_PASSWORD = "123456789012";
  assert.equal(isBackupPasswordReady(), true);
  assert.deepEqual(backupPasswordStatus(), { ok: true, password: "123456789012" });
});

test("unset and empty are 'missing', distinct from 'short'", () => {
  delete process.env.BACKUP_DB_PASSWORD;
  assert.deepEqual(backupPasswordStatus(), { ok: false, kind: "missing" });
  process.env.BACKUP_DB_PASSWORD = "";
  assert.deepEqual(backupPasswordStatus(), { ok: false, kind: "missing" });
});

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

test("nothing else in src reads BACKUP_DB_PASSWORD or declares its own floor", () => {
  const offenders: string[] = [];
  for (const file of sourceFiles("src")) {
    if (file === join("src", "lib", "backup-password.ts")) continue;
    const text = readFileSync(file, "utf8");
    if (/process\.env\.BACKUP_DB_PASSWORD/.test(text)) offenders.push(`${file}: reads BACKUP_DB_PASSWORD`);
    if (/MIN_BACKUP_PASSWORD_LEN\s*=/.test(text)) offenders.push(`${file}: declares MIN_BACKUP_PASSWORD_LEN`);
  }
  assert.deepEqual(offenders, []);
});
