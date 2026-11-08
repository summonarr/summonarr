import { prisma } from "@/lib/prisma";
import { parseRateLimit } from "@/lib/rate-limit";

// The per-user push registration cap, read by both registration routes
// (/api/push/subscribe, /api/push/apns) and shown on the profile page. One
// default and one parse, so the routes and the page can't disagree about it.
export const DEFAULT_MAX_PUSH_SUBSCRIPTIONS = 5;

/** The `maxPushSubscriptions` Setting, or the default when unset or malformed. 0 or less means no cap. */
export async function readPushSubscriptionCap(): Promise<number> {
  const row = await prisma.setting.findUnique({ where: { key: "maxPushSubscriptions" } });
  return parseRateLimit(row?.value, DEFAULT_MAX_PUSH_SUBSCRIPTIONS);
}
