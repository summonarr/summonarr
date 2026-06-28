import { Prisma } from "@/generated/prisma";

// Retry a Serializable transaction on a write-conflict (P2034): concurrent
// read+insert transactions (e.g. the request quota count+create) conflict and
// Postgres aborts one; retrying re-reads the committed state. Without this a
// quota-boundary race surfaces as a 500 instead of the correct 429/409. Used by
// POST /api/requests and the bulk request route.
export async function runWithSerializableRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (
        attempt < attempts &&
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2034"
      ) {
        continue;
      }
      throw err;
    }
  }
}
