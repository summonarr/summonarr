import { auth, isTokenExpired } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export type CronTrigger = "admin" | "cron";

export async function resolveCronTrigger(): Promise<CronTrigger> {
  const session = await auth();
  return session?.user && !isTokenExpired(session) ? "admin" : "cron";
}

export async function recordCronRun(params: {
  target: string;
  status: "ok" | "error";
  durationMs: number;
  trigger: CronTrigger;
  details?: Record<string, unknown>;
}): Promise<void> {
  const { target, status, durationMs, trigger, details } = params;
  const serializedDetails = details ? JSON.stringify(details) : null;
  try {
    await prisma.cronRun.upsert({
      where: { target },
      create: { target, lastRunAt: new Date(), durationMs, status, trigger, details: serializedDetails },
      update: { lastRunAt: new Date(), durationMs, status, trigger, details: serializedDetails },
    });
  } catch (err) {
    console.error(`[cron-run] failed to record ${target}:`, err);
  }
}
