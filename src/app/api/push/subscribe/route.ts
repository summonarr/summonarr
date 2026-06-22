import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { checkRateLimit, parseRateLimit } from "@/lib/rate-limit";
import { resolveToSafeUrl } from "@/lib/ssrf";
import { encryptToken } from "@/lib/token-crypto";
import { sanitizeText } from "@/lib/sanitize";
import { readJsonCapped } from "@/lib/body-size";

const DEFAULT_MAX_PUSH_SUBSCRIPTIONS = 5;

export const POST = withAuth(async (req, _ctx, session) => {
  if (!checkRateLimit(`push-sub:${session.user.id}`, 10, 60 * 1000)) {
    return NextResponse.json({ error: "Too many requests — try again later" }, { status: 429 });
  }

  const parsed = await readJsonCapped<{ endpoint?: string; keys?: { p256dh?: string; auth?: string }; label?: string }>(req, 32768);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed;

  const { endpoint, keys, label } = body;
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return NextResponse.json({ error: "endpoint, keys.p256dh, and keys.auth are required" }, { status: 400 });
  }
  const p256dh = keys.p256dh;
  const auth = keys.auth;

  // Cheap field-length checks first — no DNS, no DB. Doing this before
  // resolveToSafeUrl avoids resolving a 64KB attacker-controlled URL.
  if (endpoint.length > 2048 || p256dh.length > 256 || auth.length > 256) {
    return NextResponse.json({ error: "Push subscription fields exceed maximum length" }, { status: 400 });
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

  const existing = await prisma.pushSubscription.findUnique({ where: { endpoint: safeEndpoint } });
  if (existing && existing.userId !== session.user.id) {
    return NextResponse.json({ error: "Endpoint already registered to another user" }, { status: 409 });
  }

  const alreadyOwns = existing?.userId === session.user.id;

  const capRow = await prisma.setting.findUnique({ where: { key: "maxPushSubscriptions" } });
  const cap = parseRateLimit(capRow?.value, DEFAULT_MAX_PUSH_SUBSCRIPTIONS);

  // sanitizeText also strips control chars and Unicode bidi-overrides, which
  // matters because labels get captured by the audit log (auditContext bundles
  // user-controlled strings into `details`) — a bidi-override would otherwise
  // let a user spoof apparent identity in audit-table views.
  const sanitizedLabel = label
    ? (sanitizeText(label).slice(0, 100) || undefined)
    : undefined;

  // Cap-check + oldest-eviction + upsert all live in one transaction so two
  // concurrent registrations can't both pass the count check and end up with
  // the user one-over-cap. Ordering: count → maybe delete oldest → upsert.
  await prisma.$transaction(async (tx) => {
    if (!alreadyOwns && cap > 0) {
      const count = await tx.pushSubscription.count({ where: { userId: session.user.id } });
      if (count >= cap) {
        const oldest = await tx.pushSubscription.findFirst({
          where: { userId: session.user.id },
          orderBy: { createdAt: "asc" },
        });
        if (oldest) {
          // deleteMany (not delete().catch()): a concurrent delete of the same
          // row makes delete() throw P2025, and catching it inside a top-level
          // $transaction still aborts the tx (no SAVEPOINT) → the upsert below is
          // silently rolled back and the subscription is dropped (guardrail 23).
          // deleteMany returns count:0 on a missing row instead of throwing.
          await tx.pushSubscription.deleteMany({ where: { id: oldest.id } });
        }
      }
    }

    await tx.pushSubscription.upsert({
      where: { endpoint: safeEndpoint },
      update: { p256dh: encryptToken(p256dh), auth: encryptToken(auth), ...(sanitizedLabel !== undefined && { label: sanitizedLabel }) },
      create: { endpoint: safeEndpoint, p256dh: encryptToken(p256dh), auth: encryptToken(auth), userId: session.user.id, label: sanitizedLabel },
    });
  });

  return NextResponse.json({ ok: true });
});

export const DELETE = withAuth(async (req, _ctx, session) => {
  const parsed = await readJsonCapped<{ endpoint?: string }>(req, 32768);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed;

  if (!body.endpoint) {
    return NextResponse.json({ error: "endpoint is required" }, { status: 400 });
  }

  const canonicalEndpoint = (await resolveToSafeUrl(body.endpoint)) ?? body.endpoint;

  await prisma.pushSubscription.deleteMany({
    where: { endpoint: canonicalEndpoint, userId: session.user.id },
  });

  return NextResponse.json({ ok: true });
});
