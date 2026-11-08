import type { Translator } from "./i18n/translate";

// Client-facing translation of the backup pipeline's fixed error messages.
//
// backup-crypto.ts and backup-import.ts phrase their failures in English and
// are shared by the admin and first-run restores, so they stay English and
// untouched; every backup route translates on the way out. The exact English
// text is the lookup key — a message with no entry (one carrying a dynamic
// size, version or fingerprint) passes through unchanged rather than being
// lost. tests/i18n-api-admin.test.mts fails on a fixed message with no entry.
// The two setup-only messages reuse the setup routes' own keys (same text).
const BACKUP_MESSAGE_KEYS: Record<string, string> = {
  "Password is required for encrypted backups": "apiAdmin.backup.lib.passwordRequired",
  "Backup file is truncated (incomplete header)": "apiAdmin.backup.lib.truncatedHeader",
  "Not a valid encrypted backup file (bad magic bytes)": "apiAdmin.backup.lib.badMagic",
  "Backup file is truncated (missing auth tag)": "apiAdmin.backup.lib.truncatedTag",
  "Invalid password or corrupted backup": "apiAdmin.backup.lib.invalidPassword",
  "Backup file is not an encrypted Summonarr dump.": "apiAdmin.backup.lib.notEncrypted",
  "Failed to read backup": "apiAdmin.backup.lib.readFailed",
  "Backup contains no data statements — refusing to wipe the database with an empty restore.": "apiAdmin.backup.lib.emptyRestore",
  "Restore failed and was rolled back — the database is unchanged. Check the server logs for details.": "apiAdmin.backup.lib.rolledBack",
  "Setup import is only available on a fresh server with no users.": "apiAuth.setup.notFresh",
  "Pre-authentication restore is disabled on this internet-facing instance. Set SUMMONARR_ALLOW_SETUP_RESTORE=true to enable a first-run restore, then unset it once the admin account exists.": "apiAuth.setup.restoreDisabled",
};

export function localizeBackupMessage(message: string, t: Translator): string {
  const key = BACKUP_MESSAGE_KEYS[message];
  return key ? t(key) : message;
}
