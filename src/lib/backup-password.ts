// The BACKUP_DB_PASSWORD rule, shared by the five backup routes (export, the
// two admin restores, the two first-run restores) and the two pages that say
// whether backup is usable. The password both encrypts the dump and gates the
// unauthenticated first-run restore, so a weak one is worse than none.
//
// Reads process.env, so it is server-only by nature: pages pass booleans to
// client components, never the value. Zero imports on purpose.

export const MIN_BACKUP_PASSWORD_LEN = 12;

export type BackupPasswordStatus =
  | { ok: true; password: string }
  | { ok: false; kind: "missing" | "short" };

export function backupPasswordStatus(): BackupPasswordStatus {
  const password = process.env.BACKUP_DB_PASSWORD ?? "";
  if (password.length === 0) return { ok: false, kind: "missing" };
  if (password.length < MIN_BACKUP_PASSWORD_LEN) return { ok: false, kind: "short" };
  return { ok: true, password };
}

export function isBackupPasswordReady(): boolean {
  return backupPasswordStatus().ok;
}
