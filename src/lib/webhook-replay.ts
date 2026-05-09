import { createHash } from "node:crypto";
import { Prisma } from "@/generated/prisma";
import { prisma } from "@/lib/prisma";

// 24-hour TTL covers Sonarr/Radarr long retry windows; Plex/Jellyfin retries are much shorter
const TTL_MS = 24 * 60 * 60 * 1000;

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

// Recursively sort object keys so structurally-identical JSON payloads with different key orderings
// produce the same digest. Arrays preserve order. Primitives pass through.
function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = canonicalize((value as Record<string, unknown>)[key]);
  }
  return out;
}

// JSON-payload digest for sources that always parse to JSON (Jellyfin, Sonarr, Radarr).
// Canonicalizes key order before hashing so a replay with reordered fields still hits the same key.
function digestForJson(source: string, secret: string, parsedJson: unknown): string {
  return digest(source, secret, JSON.stringify(canonicalize(parsedJson)));
}

export async function checkAndRecordWebhook(
  source: string,
  secret: string,
  body: Uint8Array | string,
): Promise<boolean> {
  const key = digest(source, secret, body);
  return checkAndRecordDigest(key);
}

export async function checkAndRecordWebhookJson(
  source: string,
  secret: string,
  parsedJson: unknown,
): Promise<boolean> {
  const key = digestForJson(source, secret, parsedJson);
  return checkAndRecordDigest(key);
}

async function checkAndRecordDigest(key: string): Promise<boolean> {
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
