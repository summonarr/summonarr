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
  | "P2034"; // transaction write conflict / deadlock — retry it

export function isPrismaErrorCode(err: unknown, code: PrismaErrorCode): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { name?: unknown; code?: unknown };
  return e.name === "PrismaClientKnownRequestError" && e.code === code;
}
