// The browser's check that a picked file is an encrypted Summonarr backup,
// before any of it is uploaded: the first-run restore (/setup) and the admin
// backup page both refuse a plain-SQL dump here. The server's own copy of the
// header is backup-crypto.ts's ENCRYPTED_MAGIC (node Buffer, not importable in
// the browser); tests/backup-file.test.mts pins the two equal.
//
// Zero imports.

/** The magic bytes every encrypted backup starts with (ASCII). */
export const ENCRYPTED_BACKUP_MAGIC = "RBKBKP01";

/** True when the file's leading bytes match the encrypted-backup magic header. */
export async function isEncryptedBackupFile(file: Blob): Promise<boolean> {
  if (file.size < ENCRYPTED_BACKUP_MAGIC.length) return false;
  const head = await file.slice(0, ENCRYPTED_BACKUP_MAGIC.length).arrayBuffer();
  const bytes = new Uint8Array(head);
  for (let i = 0; i < ENCRYPTED_BACKUP_MAGIC.length; i++) {
    if (bytes[i] !== ENCRYPTED_BACKUP_MAGIC.charCodeAt(i)) return false;
  }
  return true;
}
