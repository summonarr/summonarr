// Batch writes for library-sized data (guardrails 4 and 23c): the transaction
// budget, the Postgres-side limits a batch transaction can opt into, and the
// chunked createMany every bulk insert goes through.
import type { PrismaTxClient } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma";

// The extended client's transaction client (see PrismaTxClient in ./prisma).
export type LibraryTxClient = PrismaTxClient;

// Always pass BATCH_TX_TIMEOUT to $transaction for library-sized writes to avoid Prisma's default 5s timeout
export const BATCH_TX_TIMEOUT = 30_000;

// Postgres-side limits for a batch transaction, below BATCH_TX_TIMEOUT.
//
// Prisma's timeout never reaches Postgres: when it fires, Prisma queues a
// ROLLBACK behind the statement still running, so that statement keeps its
// locks and its connection until it finishes on its own (an edge write held
// them for 39s against a 30s limit). With these set, Postgres cancels a stuck
// statement itself, a wait on another transaction's rows fails fast, and the
// error names the cause (txFailureKind) instead of a P2028 on the NEXT query.
export const BATCH_TX_STATEMENT_TIMEOUT = 20_000;
export const BATCH_TX_LOCK_TIMEOUT = 10_000;

// Run FIRST inside the transaction. set_config(…, true) is SET LOCAL: it ends
// with the transaction and never leaks onto the pooled connection.
//
// Opt-in, NOT for every batch transaction: lock_timeout also bounds a wait on
// pg_advisory_xact_lock, so a transaction that serializes on one (the library
// swap, 2001,x) would fail after 10s instead of queueing behind the holder.
// statement_timeout would likewise cut off a legitimately long INSERT … SELECT.
export async function setBatchTxTimeouts(
  tx: Pick<LibraryTxClient, "$executeRaw">,
  limits: { statementMs?: number; lockMs?: number } = {},
): Promise<void> {
  const statement = `${limits.statementMs ?? BATCH_TX_STATEMENT_TIMEOUT}ms`;
  const lock = `${limits.lockMs ?? BATCH_TX_LOCK_TIMEOUT}ms`;
  await tx.$executeRaw(
    Prisma.sql`SELECT set_config('statement_timeout', ${statement}, true), set_config('lock_timeout', ${lock}, true)`,
  );
}
// Raw createMany on library-sized datasets blows transaction timeouts; this chunk size keeps each batch safe
export const CREATE_MANY_BATCH = 5_000;

// Postgres takes at most 32,766 bind parameters per statement (Prisma's own
// limit for postgres). A createMany past it is split by Prisma into several
// INSERTs that run IN PARALLEL inside an internal transaction on ONE
// connection; pg queues them and, from the third, logs "Calling client.query()
// when the client is already executing a query is deprecated" (pg@9 removes
// the queue). The Jellyfin staging load did exactly that at boot: 5,000 rows ×
// 14 parameters = 70,000, three INSERTs at once. Sizing every call under the
// limit keeps each createMany ONE statement.
export const POSTGRES_MAX_BIND_PARAMS = 32_766;
// Parameters Prisma adds per row beyond the keys passed: an @default(now())
// column (measured: the staging tables' createdAt) and an @updatedAt column.
const IMPLICIT_PARAMS_PER_ROW = 2;

export function createManyBatchSize(rows: readonly Record<string, unknown>[]): number {
  const columns = new Set<string>();
  for (const row of rows) for (const key of Object.keys(row)) columns.add(key);
  const perRow = columns.size + IMPLICIT_PARAMS_PER_ROW;
  return Math.max(1, Math.min(CREATE_MANY_BATCH, Math.floor(POSTGRES_MAX_BIND_PARAMS / perRow)));
}

export async function batchCreateMany<T extends Record<string, unknown>>(
  tx: { createMany: (args: { data: T[]; skipDuplicates?: boolean }) => Promise<unknown> },
  rows: T[],
): Promise<void> {
  const size = createManyBatchSize(rows);
  for (let i = 0; i < rows.length; i += size) {
    await tx.createMany({ data: rows.slice(i, i + size), skipDuplicates: true });
  }
}
