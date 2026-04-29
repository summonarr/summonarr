import { NextRequest } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";
import { auth, isTokenExpired } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

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

// Records the last time a cron/sync job ran. Stored in the `Setting` table
// (key: `cron:lastRun:<target>`, value: JSON `{ at, durationMs, ok }`) so that
// admin observability surfaces (settings page) don't depend on whether the
// route also writes a `LIBRARY_SYNC` / `CACHE_WARM` audit row — several warm
// jobs deliberately skip audit on cron triggers to avoid flooding the table.
//
// Single writer per `target`, so no coordination required (per CLAUDE.md
// guardrail 14 on shared state).
export async function recordCronRun(
  target: string,
  durationMs: number,
  ok: boolean = true,
): Promise<void> {
  const key = `cron:lastRun:${target}`;
  const value = JSON.stringify({ at: new Date().toISOString(), durationMs, ok });
  await prisma.setting.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  }).catch(() => { /* observability write — never fail the caller */ });
}

export interface CronLastRun {
  at: string;
  durationMs: number;
  ok: boolean;
}

export function parseCronLastRun(raw: string | null | undefined): CronLastRun | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CronLastRun>;
    if (typeof parsed.at !== "string") return null;
    return {
      at: parsed.at,
      durationMs: typeof parsed.durationMs === "number" ? parsed.durationMs : 0,
      ok: parsed.ok !== false,
    };
  } catch {
    return null;
  }
}
