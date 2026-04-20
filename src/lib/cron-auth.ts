import { NextRequest } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";
import { auth, isTokenExpired } from "@/lib/auth";

// Hash both sides first so timingSafeEqual compares equal-length buffers regardless of input length
function safeCompareStrings(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

// Every cron/sync route funnels through this — accepts an active admin session OR a Bearer CRON_SECRET
export async function isCronAuthorized(request: NextRequest): Promise<boolean> {
  const session = await auth();
  if (session?.user?.role === "ADMIN" && !isTokenExpired(session)) return true;

  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = request.headers.get("authorization") ?? "";
    if (authHeader.startsWith("Bearer ") && safeCompareStrings(authHeader.slice(7), cronSecret)) return true;
  }

  return false;
}

// Always pass BATCH_TX_TIMEOUT to $transaction for library-sized writes to avoid Prisma's default 5s timeout
export const BATCH_TX_TIMEOUT = 30_000;
// Raw createMany on library-sized datasets blows transaction timeouts; this chunk size keeps each batch safe
const CREATE_MANY_BATCH = 5_000;

export async function batchCreateMany<T extends Record<string, unknown>>(
  tx: { createMany: (args: { data: T[]; skipDuplicates?: boolean }) => Promise<unknown> },
  rows: T[],
): Promise<void> {
  for (let i = 0; i < rows.length; i += CREATE_MANY_BATCH) {
    await tx.createMany({ data: rows.slice(i, i + CREATE_MANY_BATCH), skipDuplicates: true });
  }
}
