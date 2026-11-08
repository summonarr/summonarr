import { NextResponse } from "next/server";
import { prisma } from "./prisma";
import { withAdvisoryLock } from "./advisory-lock";
import { lockBusyResponse } from "./lock-http";

// The cooldown slot the admin warm routes (and the play-history retention
// purge) keep in a Setting row: a millisecond timestamp, claimed with ONE
// atomic statement so two simultaneous clicks can't both start a run.
//
// The stored value is guarded with CASE, not OR: Postgres does not promise to
// evaluate an OR left to right, so `value !~ regex OR CAST(value …)` could cast
// a non-numeric value and throw. The digit bound (15, a literal in the SQL —
// Date.now() is 13) keeps the CAST and the addition inside bigint; a longer or
// non-numeric value (a manual edit) reads as expired and is overwritten.
export async function claimCooldownSlot(key: string, cooldownMs: number, now: number): Promise<boolean> {
  const claimed = await prisma.$executeRaw`
    INSERT INTO "Setting" (key, value, "updatedAt")
    VALUES (${key}, ${String(now)}, NOW())
    ON CONFLICT (key) DO UPDATE
      SET value = EXCLUDED.value, "updatedAt" = NOW()
    WHERE CASE WHEN "Setting".value ~ '^[0-9]{1,15}$'
               THEN CAST("Setting".value AS BIGINT) + ${cooldownMs}::bigint <= ${now}::bigint
               ELSE TRUE END
  `;
  return claimed > 0;
}

// Gives back a claim whose run failed. A compare-and-swap on the exact stamp
// this caller wrote, so a newer claim (or a force stamp) is never undone.
export async function releaseCooldownSlot(key: string, claimedAt: number): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "Setting" SET value = '0', "updatedAt" = NOW()
    WHERE key = ${key} AND value = ${String(claimedAt)}
  `;
}

// Whole seconds until the slot frees up, for the 429's retry hint. Read only
// AFTER a failed claim. Never below 1: a failed claim means the slot is held,
// and an unreadable stored value must not produce NaN or a negative wait.
export async function cooldownRetrySeconds(key: string, cooldownMs: number, now: number): Promise<number> {
  const row = await prisma.setting.findUnique({ where: { key } });
  const lastMs = row ? parseInt(row.value, 10) || 0 : 0;
  return Math.max(1, Math.ceil((cooldownMs - (now - lastMs)) / 1000));
}

export interface AdminWarmOptions {
  // The cron twin's lock, so an admin click can't run beside the cron (guardrail 41).
  lockId: number;
  cooldownKey: string;
  cooldownMs: number;
  // mdblist's force: skip the claim but still stamp the slot, so the next
  // non-force click gets a fresh window rather than an open door.
  force?: boolean;
  // The route's own translated texts.
  busyMessage: string;
  cooldownMessage: (seconds: number) => string;
  failedMessage: string;
  // Log prefix for a failed warm, e.g. "[library-warm]".
  scope: string;
  // The warm itself, its audit and its answer. A throw means the warm failed.
  run: (signal: AbortSignal, claimedAt: number) => Promise<NextResponse>;
}

// One admin warm: lock, claim the cooldown, run, answer. The claim lives INSIDE
// the lock so a lock-busy 409 can't burn the cooldown for a warm that never ran,
// and a warm that THROWS gives its claim back, so the admin can retry at once
// instead of waiting out a cooldown for work that never happened.
export function runAdminWarm(opts: AdminWarmOptions): Promise<NextResponse> {
  return withAdvisoryLock(
    opts.lockId,
    async (signal) => {
      const now = Date.now();
      if (opts.force) {
        await prisma.setting.upsert({
          where: { key: opts.cooldownKey },
          create: { key: opts.cooldownKey, value: String(now) },
          update: { value: String(now) },
        });
      } else if (!(await claimCooldownSlot(opts.cooldownKey, opts.cooldownMs, now))) {
        const seconds = await cooldownRetrySeconds(opts.cooldownKey, opts.cooldownMs, now);
        return NextResponse.json({ error: opts.cooldownMessage(seconds), retryAfter: seconds }, { status: 429 });
      }

      try {
        return await opts.run(signal, now);
      } catch (err) {
        console.warn(`${opts.scope} warm failed:`, err);
        try {
          await releaseCooldownSlot(opts.cooldownKey, now);
        } catch (releaseErr) {
          console.warn(`${opts.scope} could not release the cooldown after the failed warm:`, releaseErr);
        }
        return NextResponse.json({ error: opts.failedMessage }, { status: 500 });
      }
    },
    () => lockBusyResponse(opts.busyMessage),
  );
}
