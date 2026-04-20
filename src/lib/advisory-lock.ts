

import { Client } from "pg";

// Uses a raw pg Client (not Prisma) because advisory locks must be held on a single persistent connection;
// Prisma's pool can transparently switch connections between awaits, which would release the lock early
export async function withAdvisoryLock<T, U = T>(
  lockId: number,
  work: () => Promise<T>,
  onBusy: () => U | Promise<U>,
): Promise<T | U> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    // pg_try_advisory_lock is non-blocking — returns false immediately if another session holds the lock
    const res = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock($1::bigint) AS acquired",
      [lockId],
    );
    const acquired = res.rows[0]?.acquired ?? false;
    if (!acquired) {
      return await onBusy();
    }
    try {
      return await work();
    } finally {
      await client.query("SELECT pg_advisory_unlock($1::bigint)", [lockId]);
    }
  } finally {
    await client.end();
  }
}
