// Advisory lock 43: first-run setup. Every path that can create the first
// account or replace the whole database takes it FIRST in its transaction, then
// re-reads setup_completed_at and the user count under it: /api/auth/register,
// the first-admin promotion in auth.ts, both /api/setup restore gates, and the
// restore itself (backup-import.ts, admin restores included, so two restores
// also serialize). One statement, spelled once: a typo at one site would drop
// it out of the serialization silently. Tests match the text.
export const SETUP_LOCK_SQL = "SELECT pg_advisory_xact_lock(43)";

export async function lockSetupInTx(tx: { $executeRawUnsafe: (q: string) => Promise<unknown> }): Promise<void> {
  await tx.$executeRawUnsafe(SETUP_LOCK_SQL);
}
