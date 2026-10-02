import type { Translator } from "./i18n/translate";

// Client-facing translation of the backup pipeline's fixed error messages.
//
// backup-crypto.ts and backup-import.ts phrase their failures in English and
// are shared with the first-run /api/setup restore, so they stay English and
// untouched; the admin backup routes translate on the way out. The exact
// English text is the lookup key — a message with no entry (one carrying a
// dynamic size or version) passes through unchanged rather than being lost.
const BACKUP_MESSAGE_KEYS: Record<string, string> = {
  "Password is required for encrypted backups": "apiAdmin.backup.lib.passwordRequired",
  "Backup file is truncated (incomplete header)": "apiAdmin.backup.lib.truncatedHeader",
  "Not a valid encrypted backup file (bad magic bytes)": "apiAdmin.backup.lib.badMagic",
  "Backup file is truncated (missing auth tag)": "apiAdmin.backup.lib.truncatedTag",
  "Invalid password or corrupted backup": "apiAdmin.backup.lib.invalidPassword",
  "Backup file is not an encrypted Summonarr dump.": "apiAdmin.backup.lib.notEncrypted",
  "Failed to read backup": "apiAdmin.backup.lib.readFailed",
  "Backup contains no data statements — refusing to wipe the database with an empty restore.": "apiAdmin.backup.lib.emptyRestore",
};

export function localizeBackupMessage(message: string, t: Translator): string {
  const key = BACKUP_MESSAGE_KEYS[message];
  return key ? t(key) : message;
}
