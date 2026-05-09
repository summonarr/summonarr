import { createHash } from "node:crypto";
import { Prisma } from "@/generated/prisma";
import { prisma } from "@/lib/prisma";

const TTL_MS = 5 * 60 * 1000;

// Digest binds source + secret + body so replays to a different endpoint or with a different secret are distinct keys
function digest(source: string, secret: string, body: Uint8Array | string): string {
  const h = createHash("sha256");
  h.update(source);
  h.update("\0");
  h.update(secret);
  h.update("\0");
  if (typeof body === "string") h.update(body, "utf8");
  else h.update(body);
  return h.digest("hex");
}

export async function checkAndRecordWebhook(
  source: string,
  secret: string,
  body: Uint8Array | string,
): Promise<boolean> {
  const key = digest(source, secret, body);
  const now = new Date();

  // Atomic create-or-detect: a parallel webhook with the same digest can't slip past a
  // findUnique-then-upsert window. If create succeeds, this is the first delivery; if it
  // fails with P2002, the row already exists and we treat it as a replay (refresh TTL).
  try {
    await prisma.webhookReplay.create({
      data: { digest: key, expiresAt: new Date(Date.now() + TTL_MS) },
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const existing = await prisma.webhookReplay.findUnique({
        where: { digest: key },
        select: { expiresAt: true },
      });
      if (existing && existing.expiresAt > now) return false;
      await prisma.webhookReplay.update({
        where: { digest: key },
        data: { expiresAt: new Date(Date.now() + TTL_MS) },
      }).catch(() => {});
    } else {
      throw e;
    }
  }

  // 1-in-100 chance of cleaning expired rows to keep the table small without a dedicated cron
  if (Math.random() < 0.01) {
    prisma.webhookReplay.deleteMany({ where: { expiresAt: { lt: now } } }).catch(() => {});
  }

  return true;
}

export function __resetWebhookReplayCacheForTests(): void {
  // No-op in DB-backed mode; kept for interface compatibility
}
