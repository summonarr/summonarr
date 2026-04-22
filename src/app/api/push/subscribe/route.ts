import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { checkRateLimit, parseRateLimit } from "@/lib/rate-limit";
import { resolveToSafeUrl } from "@/lib/ssrf";
import { encryptToken } from "@/lib/token-crypto";

const DEFAULT_MAX_PUSH_SUBSCRIPTIONS = 5;

export async function POST(req: NextRequest) {
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;

  if (!checkRateLimit(`push-sub:${session.user.id}`, 10, 60 * 1000)) {
    return NextResponse.json({ error: "Too many requests — try again later" }, { status: 429 });
  }

  let body: { endpoint?: string; keys?: { p256dh?: string; auth?: string }; label?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { endpoint, keys, label } = body;
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return NextResponse.json({ error: "endpoint, keys.p256dh, and keys.auth are required" }, { status: 400 });
  }

  // Allowlist known push services before DNS resolution to prevent SSRF via push endpoint registration
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "https:") {
      return NextResponse.json({ error: "Push endpoint must use HTTPS" }, { status: 400 });
    }
    const host = url.hostname.toLowerCase();
    const allowedHosts = [
      "fcm.googleapis.com",
      "updates.push.services.mozilla.com",
      "push.services.mozilla.com",
    ];
    const allowedSuffixes = [
      ".notify.windows.com",
      ".push.apple.com",
      ".web.push.apple.com",
      ".push.services.mozilla.com",
    ];
    const isAllowed = allowedHosts.includes(host)
      || allowedSuffixes.some((suffix) => host.endsWith(suffix));
    if (!isAllowed) {
      return NextResponse.json({ error: "Push endpoint is not from a recognized push service" }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: "Invalid push endpoint URL" }, { status: 400 });
  }

  const safeEndpoint = await resolveToSafeUrl(endpoint);
  if (!safeEndpoint) {
    return NextResponse.json({ error: "Push endpoint resolves to a disallowed address" }, { status: 400 });
  }

  if (endpoint.length > 2048 || keys.p256dh.length > 256 || keys.auth.length > 256) {
    return NextResponse.json({ error: "Push subscription fields exceed maximum length" }, { status: 400 });
  }

  const existing = await prisma.pushSubscription.findUnique({ where: { endpoint: safeEndpoint } });
  if (existing && existing.userId !== session.user.id) {
    return NextResponse.json({ error: "Endpoint already registered to another user" }, { status: 409 });
  }

  const alreadyOwns = existing?.userId === session.user.id;

  if (!alreadyOwns) {
    const capRow = await prisma.setting.findUnique({ where: { key: "maxPushSubscriptions" } });
    const cap = parseRateLimit(capRow?.value, DEFAULT_MAX_PUSH_SUBSCRIPTIONS);

    if (cap > 0) {
      // Enforce per-user subscription cap; evict oldest subscription rather than rejecting the new one
      await prisma.$transaction(async (tx) => {
        const count = await tx.pushSubscription.count({ where: { userId: session.user.id } });
        if (count >= cap) {
          const oldest = await tx.pushSubscription.findFirst({
            where: { userId: session.user.id },
            orderBy: { createdAt: "asc" },
          });
          if (oldest) {
            // Ignore failure in case another request already deleted it
            await tx.pushSubscription.delete({ where: { id: oldest.id } }).catch(() => {});
          }
        }
      });
    }
  }

  const sanitizedLabel = label ? label.replace(/[<>]/g, "").replace(/\0/g, "").trim().slice(0, 100) || undefined : undefined;

  await prisma.pushSubscription.upsert({
    where: { endpoint: safeEndpoint },
    update: { p256dh: encryptToken(keys.p256dh), auth: encryptToken(keys.auth), ...(sanitizedLabel !== undefined && { label: sanitizedLabel }) },
    create: { endpoint: safeEndpoint, p256dh: encryptToken(keys.p256dh), auth: encryptToken(keys.auth), userId: session.user.id, label: sanitizedLabel },
  });

  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;

  let body: { endpoint?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.endpoint) {
    return NextResponse.json({ error: "endpoint is required" }, { status: 400 });
  }

  const canonicalEndpoint = (await resolveToSafeUrl(body.endpoint)) ?? body.endpoint;

  await prisma.pushSubscription.deleteMany({
    where: { endpoint: canonicalEndpoint, userId: session.user.id },
  });

  return NextResponse.json({ ok: true });
}
