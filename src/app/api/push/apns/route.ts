import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { checkRateLimit, parseRateLimit } from "@/lib/rate-limit";
import { encryptToken } from "@/lib/token-crypto";
import { sanitizeText } from "@/lib/sanitize";
import { readJsonCapped } from "@/lib/body-size";

const DEFAULT_MAX_PUSH_SUBSCRIPTIONS = 5;
// APNs device tokens are 32 bytes (64 hex) today; Apple reserves the right to
// grow them, so accept a generous range — but whole bytes only (even-length
// hex, 32–100 bytes). The relay validates even-length; an odd-length token
// would register here but never deliver.
const DEVICE_TOKEN_RE = /^(?:[0-9a-fA-F]{2}){32,100}$/;

export const POST = withAuth(async (req, _ctx, session) => {
  if (!checkRateLimit(`push-apns:${session.user.id}`, 10, 60 * 1000)) {
    return NextResponse.json({ error: "Too many requests — try again later" }, { status: 429 });
  }

  const parsed = await readJsonCapped<{ deviceToken?: string; label?: string; publicKey?: string }>(req, 16384);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed;

  const deviceToken = typeof body.deviceToken === "string" ? body.deviceToken.trim() : "";
  if (!DEVICE_TOKEN_RE.test(deviceToken)) {
    return NextResponse.json({ error: "deviceToken must be a hex APNs token" }, { status: 400 });
  }

  // Synthetic unique handle so upsert/prune can key off `endpoint` for both web
  // and iOS rows without a second unique column.
  const endpoint = `apns:${deviceToken}`;

  const existing = await prisma.pushSubscription.findUnique({ where: { endpoint } });
  if (existing && existing.userId !== session.user.id) {
    // APNs tokens are per-device, but the prior row's ownership is proof the
    // device was registered by another account. Silently reassigning it (no
    // ownership proof from the caller) would let any user hijack another
    // account's device token. Require the prior owner to DELETE first — a
    // legitimate device handoff goes through sign-out (mirrors /api/push/subscribe).
    return NextResponse.json({ error: "Device already registered to another account" }, { status: 409 });
  }
  const alreadyOwns = existing?.userId === session.user.id;

  const sanitizedLabel = body.label
    ? (sanitizeText(body.label).slice(0, 100) || undefined)
    : undefined;

  // Optional E2E device public key (P-256, X9.63 uncompressed = 65 bytes,
  // base64). Stored only if well-formed; a missing/malformed key just means this
  // device gets generic (content-free) pushes instead of encrypted rich ones.
  let validPublicKey: string | null = null;
  if (typeof body.publicKey === "string" && body.publicKey.length > 0 && body.publicKey.length <= 128) {
    const buf = Buffer.from(body.publicKey, "base64");
    if (buf.length === 65 && buf[0] === 0x04) validPublicKey = body.publicKey;
  }

  const capRow = await prisma.setting.findUnique({ where: { key: "maxPushSubscriptions" } });
  const cap = parseRateLimit(capRow?.value, DEFAULT_MAX_PUSH_SUBSCRIPTIONS);

  // Cap-check + oldest-eviction + upsert in one transaction so concurrent
  // registrations can't push the user one-over-cap (mirrors /api/push/subscribe).
  await prisma.$transaction(async (tx) => {
    if (!alreadyOwns && cap > 0) {
      const count = await tx.pushSubscription.count({ where: { userId: session.user.id } });
      if (count >= cap) {
        const oldest = await tx.pushSubscription.findFirst({
          where: { userId: session.user.id },
          orderBy: { createdAt: "asc" },
        });
        if (oldest) {
          // deleteMany (not delete) — a concurrent delete of the same row throws
          // P2025 inside a top-level tx (no SAVEPOINT) and silently rolls back
          // the upsert (guardrail 23). deleteMany returns count:0 instead.
          await tx.pushSubscription.deleteMany({ where: { id: oldest.id } });
        }
      }
    }

    await tx.pushSubscription.upsert({
      where: { endpoint },
      update: {
        platform: "ios",
        deviceToken: encryptToken(deviceToken),
        publicKey: validPublicKey,
        ...(sanitizedLabel !== undefined && { label: sanitizedLabel }),
      },
      create: {
        endpoint,
        platform: "ios",
        deviceToken: encryptToken(deviceToken),
        publicKey: validPublicKey,
        userId: session.user.id,
        label: sanitizedLabel,
      },
    });
  });

  return NextResponse.json({ ok: true });
});

export const DELETE = withAuth(async (req, _ctx, session) => {
  const parsed = await readJsonCapped<{ deviceToken?: string }>(req, 16384);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed;

  const deviceToken = typeof body.deviceToken === "string" ? body.deviceToken.trim() : "";
  if (!deviceToken) {
    return NextResponse.json({ error: "deviceToken is required" }, { status: 400 });
  }

  await prisma.pushSubscription.deleteMany({
    where: { endpoint: `apns:${deviceToken}`, userId: session.user.id },
  });

  return NextResponse.json({ ok: true });
});
