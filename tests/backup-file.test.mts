// The browser's encrypted-backup header check (src/lib/client/backup-file.ts),
// shared by the first-run restore and the admin backup page: its magic must be
// the server's own (backup-crypto.ts), and only a file that starts with it passes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ENCRYPTED_BACKUP_MAGIC, isEncryptedBackupFile } from "../src/lib/client/backup-file.ts";
import { ENCRYPTED_MAGIC } from "../src/lib/backup-crypto.ts";

test("the browser's magic header is the server's", () => {
  assert.equal(ENCRYPTED_BACKUP_MAGIC, ENCRYPTED_MAGIC.toString("ascii"));
});

test("only a file that starts with the magic header is an encrypted backup", async () => {
  assert.equal(await isEncryptedBackupFile(new Blob([`${ENCRYPTED_BACKUP_MAGIC}payload`])), true);
  assert.equal(await isEncryptedBackupFile(new Blob([ENCRYPTED_BACKUP_MAGIC])), true);
  assert.equal(await isEncryptedBackupFile(new Blob(["-- plain SQL dump"])), false);
  assert.equal(await isEncryptedBackupFile(new Blob([ENCRYPTED_BACKUP_MAGIC.slice(0, 7)])), false, "shorter than the header");
  assert.equal(await isEncryptedBackupFile(new Blob([])), false);
});

test("the setup restore and the admin backup page both use the shared check, with no copy of the header", () => {
  for (const file of ["../src/app/setup/setup-import-panel.tsx", "../src/components/admin/backup-ui.tsx"]) {
    const src = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(src, /from "@\/lib\/client\/backup-file"/, file);
    assert.doesNotMatch(src, /"RBKBKP01"/, `${file} keeps no copy of the magic`);
  }
});

test("the setup restore offers Cancel while chunks are sending, and never shows a raw exception's text", () => {
  const src = readFileSync(new URL("../src/app/setup/setup-import-panel.tsx", import.meta.url), "utf8");
  assert.match(src, /\{progress\.phase === "upload" && \(\s*<Button[^>]*onClick=\{onCancel\}/);
  assert.match(src, /function cancelUpload\(\) \{\s*uploadAbortRef\.current\?\.abort\(\);/);
  assert.doesNotMatch(src, /err\.message/);
});
