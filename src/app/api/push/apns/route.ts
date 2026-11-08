import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/rate-limit";
import { encryptToken } from "@/lib/token-crypto";
import { readJsonCapped } from "@/lib/body-size";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import type { Translator } from "@/lib/i18n/translate";
import { maintenanceGuard } from "@/lib/maintenance";
import { isFeatureEnabled } from "@/lib/features";
import { apnsEndpointFor, legacyApnsEndpointFor } from "@/lib/apns-endpoint";
import { evictOldestForCapInTx, lockUserPushRegistrationsInTx } from "@/lib/push-registration";
import { readPushSubscriptionCap } from "@/lib/push-cap";
import { parseApnsDeviceToken, parseApnsPublicKey, parsePushLabel } from "@/lib/push-body";

// POST /api/push/apns — registers (or updates) an iOS device's APNs token as a
// push subscription for the caller, capped per-user with oldest-eviction.
export const POST = withAuth(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  // Same two gates as /api/push/subscribe: registration is a personal mutation
  // (blocked during maintenance like profile delete/password — DELETE stays open
  // so a device can always opt out), and a registration stored while push is off
  // would never deliver. Without them one user's web and iOS devices answered
  // "can I register for push" in opposite ways.
  const maint = await maintenanceGuard(session);
  if (maint) return maint;
  if (!(await isFeatureEnabled("feature.integration.push"))) {
    return NextResponse.json({ error: t("apiUser.push.disabled") }, { status: 403 });
  }
  if (!checkRateLimit(`push-apns:${session.user.id}`, 10, 60 * 1000)) {
    return NextResponse.json({ error: t("apiUser.common.tooManyRequestsLater") }, { status: 429 });
  }

  const parsed = await readJsonCapped<{ deviceToken?: unknown; label?: unknown; publicKey?: unknown }>(req, 16384);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed;

  const deviceToken = parseApnsDeviceToken(body.deviceToken);
  if (deviceToken === null) {
    return NextResponse.json({ error: t("apiUser.push.deviceTokenInvalid") }, { status: 400 });
  }

  // Synthetic unique handle so upsert/prune can key off `endpoint` for both web
  // and iOS rows without a second unique column — a HASH of the token, never
  // the token itself, which is stored only encrypted (apns-endpoint.ts). A row
  // still under the old plaintext handle (before the boot migration reached
  // it) counts as this device too, and is moved onto the hashed one below.
  const endpoint = apnsEndpointFor(deviceToken);
  const legacyEndpoint = legacyApnsEndpointFor(deviceToken);

  const [hashedRow, legacyRow] = await Promise.all([
    prisma.pushSubscription.findUnique({ where: { endpoint } }),
    prisma.pushSubscription.findUnique({ where: { endpoint: legacyEndpoint } }),
  ]);
  if ([hashedRow, legacyRow].some((row) => row && row.userId !== session.user.id)) {
    // APNs tokens are per-device, but the prior row's ownership is proof the
    // device was registered by another account. Silently reassigning it (no
    // ownership proof from the caller) would let any user hijack another
    // account's device token. Require the prior owner to DELETE first — a
    // legitimate device handoff goes through sign-out (mirrors /api/push/subscribe).
    return deviceTaken(t);
  }

  const label = parsePushLabel(body.label);
  const publicKey = parseApnsPublicKey(body.publicKey);
  const cap = await readPushSubscriptionCap();

  // Ownership, cap-check, oldest-eviction and upsert in one transaction under
  // the per-user lock (push-registration.ts, shared with /api/push/subscribe),
  // so concurrent registrations can't push the user one over the cap.
  const userId = session.user.id;
  const outcome = await prisma.$transaction(async (tx) => {
    await lockUserPushRegistrationsInTx(tx, userId);
    // Ownership again, under the lock: the per-user lock doesn't serialize two
    // ACCOUNTS, so another account may have registered this device since the
    // check above, and the upsert's update branch would rewrite its row.
    const owner = await tx.pushSubscription.findUnique({ where: { endpoint }, select: { userId: true } });
    if (owner && owner.userId !== userId) return "taken" as const;
    // The caller's own legacy-handle row: rename it onto the hashed handle (so
    // the upsert below updates it, keeping its createdAt for the cap's
    // oldest-first eviction), or drop it if the hashed row already exists. A
    // concurrent rename's P2002 propagates (guardrail 23) — the device simply
    // re-registers on its next launch.
    if (legacyRow) {
      if (owner) await tx.pushSubscription.deleteMany({ where: { id: legacyRow.id, userId } });
      else await tx.pushSubscription.updateMany({ where: { id: legacyRow.id, userId }, data: { endpoint } });
    }
    // Re-read under the lock: a device already registered here never evicts.
    const current = legacyRow ? await tx.pushSubscription.findUnique({ where: { endpoint }, select: { userId: true } }) : owner;
    if (current?.userId !== userId) await evictOldestForCapInTx(tx, userId, cap);

    await tx.pushSubscription.upsert({
      where: { endpoint },
      update: {
        platform: "ios",
        deviceToken: encryptToken(deviceToken),
        ...(publicKey.kind !== "keep" && { publicKey: publicKey.value }),
        ...(label !== undefined && { label }),
      },
      create: {
        endpoint,
        platform: "ios",
        deviceToken: encryptToken(deviceToken),
        publicKey: publicKey.kind === "set" ? publicKey.value : null,
        userId,
        label,
      },
    });
    return "ok" as const;
  });

  if (outcome === "taken") return deviceTaken(t);
  return NextResponse.json({ ok: true });
});

function deviceTaken(t: Translator): NextResponse {
  return NextResponse.json({ error: t("apiUser.push.deviceTaken") }, { status: 409 });
}

export const DELETE = withAuth(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  const parsed = await readJsonCapped<{ deviceToken?: unknown }>(req, 16384);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed;

  // Same lowercase normalization as POST — the handle is derived from the
  // lowercased token, so a case-shifted token here would match nothing and leave
  // the row pushing to a signed-out device.
  const deviceToken = typeof body.deviceToken === "string" ? body.deviceToken.trim().toLowerCase() : "";
  if (!deviceToken) {
    return NextResponse.json({ error: t("apiUser.push.deviceTokenRequired") }, { status: 400 });
  }

  // Both handles: a row the boot migration hasn't reached yet must still go.
  await prisma.pushSubscription.deleteMany({
    where: { endpoint: { in: [apnsEndpointFor(deviceToken), legacyApnsEndpointFor(deviceToken)] }, userId: session.user.id },
  });

  return NextResponse.json({ ok: true });
});
