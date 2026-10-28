// Which Prisma error is this? — read STRUCTURALLY, from the error's `code`.
//
// NEVER `err instanceof Prisma.PrismaClientKnownRequestError` (guardrail 23b).
// Turbopack copies the generated client into every server chunk that imports
// it, so a route's `Prisma` namespace and the class of the error the shared
// client threw can be two different copies. In `next dev` the client is cached
// on globalThis (prisma.ts), so whichever chunk loaded first created it and
// every other chunk's instanceof is false: a tolerated unique violation became
// a 500 (POST /api/hidden twice answered 500, not its 409), a P2025 "already
// gone" became a 500, and a serialization conflict (P2034) was never retried.
//
// The gate is the error's NAME plus its code. Prisma sets `name` as an own
// property in the constructor, so it is identical in every copy of the client,
// while a look-alike (a plain Error that merely carries `code: "P2002"`, or a
// wrapper's shaped object) is still refused — the fail-closed behaviour the
// webhook-replay and serializable-retry pins require.

export type PrismaErrorCode =
  | "P2002" // unique constraint violation
  | "P2025" // record required for the operation not found
  | "P2028" // transaction API error: expired, or no connection in time
  | "P2034"; // transaction write conflict / deadlock — retry it

export function isPrismaErrorCode(err: unknown, code: PrismaErrorCode): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { name?: unknown; code?: unknown };
  return e.name === "PrismaClientKnownRequestError" && e.code === code;
}

// The Postgres SQLSTATE behind a Prisma error, or null. Prisma names only some
// Postgres errors. The rest arrive as P2039 "Database error" (a model query) or
// P2010 "Raw query failed", and a deadlock as P2034. In every case the driver
// adapter keeps the original code on meta.driverAdapterError.cause.originalCode,
// and Prisma also writes it into the message as "Code: `57014`".
export function postgresErrorCode(err: unknown): string | null {
  if (typeof err !== "object" || err === null) return null;
  const e = err as {
    name?: unknown;
    message?: unknown;
    meta?: { driverAdapterError?: { cause?: { originalCode?: unknown } } };
  };
  if (e.name !== "PrismaClientKnownRequestError") return null;
  const original = e.meta?.driverAdapterError?.cause?.originalCode;
  if (typeof original === "string") return original;
  const inMessage = typeof e.message === "string" ? /Code: `([0-9A-Z]{5})`/.exec(e.message) : null;
  return inMessage ? inMessage[1] : null;
}

export type TxFailureKind =
  | "lock-timeout" // 55P03: waited past lock_timeout for rows another transaction holds
  | "statement-timeout" // 57014 from statement_timeout: Postgres cancelled a slow statement
  | "cancelled" // 57014 for any other reason (pg_cancel_backend, shutdown)
  | "deadlock" // 40P01
  | "serialization" // 40001
  | "expired" // P2028: the transaction ran past Prisma's own timeout
  | "start-timeout" // P2028: no pooled connection within maxWait
  | "other";

// Why did a transaction fail? Read from the Postgres code first, then from the
// one Prisma code that has no Postgres code behind it (P2028). The two P2028
// cases share a code and differ only in Prisma's fixed message text.
export function txFailureKind(err: unknown): TxFailureKind {
  const message = typeof err === "object" && err !== null && typeof (err as { message?: unknown }).message === "string"
    ? (err as { message: string }).message
    : "";
  switch (postgresErrorCode(err)) {
    case "55P03":
      return "lock-timeout";
    case "57014":
      return /statement timeout/i.test(message) ? "statement-timeout" : "cancelled";
    case "40P01":
      return "deadlock";
    case "40001":
      return "serialization";
  }
  if (isPrismaErrorCode(err, "P2028")) {
    if (/unable to start a transaction/i.test(message)) return "start-timeout";
    if (/expired transaction/i.test(message)) return "expired";
  }
  return "other";
}
