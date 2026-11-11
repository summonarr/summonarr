import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/rate-limit";
import { resolveToSafeUrl } from "@/lib/ssrf";
import { encryptToken } from "@/lib/token-crypto";
import { readJsonCapped } from "@/lib/body-size";
import { isFeatureEnabled } from "@/lib/features";
import { maintenanceGuard } from "@/lib/maintenance";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import type { Translator } from "@/lib/i18n/translate";
import {
  clearPushEndpointRemovalInTx,
  countUserPushRegistrationsInTx,
  evictOldestForCapInTx,
  isPushEndpointRemovedInTx,
  lockUserPushRegistrationsInTx,
  tombstoneRemovedPushRowsInTx,
} from "@/lib/push-registration";
import { readPushSubscriptionCap } from "@/lib/push-cap";
import { isPrismaErrorCode } from "@/lib/prisma-errors";
import { canonicalizePushEndpoint, checkWebPushEndpoint, parsePushLabel, type WebPushEndpointVerdict } from "@/lib/push-body";

// The 400 for each way a Web Push endpoint fails the known-services check.
const ENDPOINT_REFUSAL: Record<Exclude<WebPushEndpointVerdict, "ok">, string> = {
  "invalid-url": "apiUser.push.endpointInvalidUrl",
  "not-https": "apiUser.push.endpointHttps",
  unrecognized: "apiUser.push.endpointUnrecognized",
};

export const POST = withAuth(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  // Personal mutation — blocked during maintenance like profile delete/password.
  // DELETE (unsubscribe) intentionally stays open so users can always opt out.
  const maint = await maintenanceGuard(session);
  if (maint) return maint;
  // Don't accept new subscriptions while push is disabled: the send path already
  // no-ops when off, so a registration stored here would never deliver.
  if (!(await isFeatureEnabled("feature.integration.push"))) {
    return NextResponse.json({ error: t("apiUser.push.disabled") }, { status: 403 });
  }
  if (!checkRateLimit(`push-sub:${session.user.id}`, 10, 60 * 1000)) {
    return NextResponse.json({ error: t("apiUser.common.tooManyRequestsLater") }, { status: 429 });
  }

  const parsed = await readJsonCapped<{ endpoint?: unknown; keys?: unknown; label?: unknown; resync?: unknown }>(req, 32768);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed;

  // The bell's once-per-page-load re-send of a subscription the browser already
  // holds (push-notifications.tsx), as opposed to the user turning push on. It
  // may restore a row the server lost — the 6g sign-out/password wipe deletes
  // every registration — but never one that was removed on purpose.
  const resync = body.resync === true;
  const fields = readSubscriptionFields(body);
  if (!fields) {
    return NextResponse.json({ error: t("apiUser.push.fieldsRequired") }, { status: 400 });
  }
  const { endpoint, p256dh, auth } = fields;

  // Cheap field-length checks first — no DNS, no DB. Doing this before
  // resolveToSafeUrl avoids resolving a 64KB attacker-controlled URL.
  if (endpoint.length > 2048 || p256dh.length > 256 || auth.length > 256) {
    return NextResponse.json({ error: t("apiUser.push.fieldsTooLong") }, { status: 400 });
  }

  // Allowlist known push services before DNS resolution to prevent SSRF via push endpoint registration
  const verdict = checkWebPushEndpoint(endpoint);
  if (verdict !== "ok") return badRequest(t, ENDPOINT_REFUSAL[verdict]);

  const safeEndpoint = await resolveToSafeUrl(endpoint);
  if (!safeEndpoint) {
    return NextResponse.json({ error: t("apiUser.push.endpointDisallowed") }, { status: 400 });
  }

  const cap = await readPushSubscriptionCap();
  const sanitizedLabel = parsePushLabel(body.label);

  // Ownership, cap and write in one transaction under the per-user lock
  // (push-registration.ts), so two concurrent registrations can't both pass the
  // count and leave the user one over the cap. Statements run one at a time and
  // nothing inside is caught (guardrails 23, 23c).
  const userId = session.user.id;
  const keys = { p256dh: encryptToken(p256dh), auth: encryptToken(auth) };
  // True once the transaction has reached its final insert, so the unique
  // violation mapped below is that insert's and no other statement's.
  let inserting = false;
  const outcome = await prisma.$transaction(async (tx) => {
    await lockUserPushRegistrationsInTx(tx, userId);
    const existing = await tx.pushSubscription.findUnique({ where: { endpoint: safeEndpoint } });
    if (existing && existing.userId !== userId) return "taken" as const;
    const alreadyOwns = existing !== null;

    if (resync) {
      // A row still stored is simply refreshed. A missing one comes back only if
      // it was not removed on purpose, and never at the cost of another device.
      if (!alreadyOwns) {
        if (await isPushEndpointRemovedInTx(tx, userId, safeEndpoint)) return "gone" as const;
        if (cap > 0 && (await countUserPushRegistrationsInTx(tx, userId)) >= cap) return "gone" as const;
      }
    } else {
      await clearPushEndpointRemovalInTx(tx, userId, safeEndpoint);
      if (!alreadyOwns) await evictOldestForCapInTx(tx, userId, cap);
    }

    // Never an upsert by endpoint: the lock is per USER, so another account can
    // insert this endpoint after the read above, and an upsert's update branch
    // would then rewrite THAT account's keys. The update is owner-scoped, and
    // the insert is the transaction's last statement, so its unique violation
    // propagates (guardrail 23) and is answered as "taken" below.
    const updated = await tx.pushSubscription.updateMany({
      where: { endpoint: safeEndpoint, userId },
      data: { ...keys, ...(sanitizedLabel !== undefined && { label: sanitizedLabel }) },
    });
    if (updated.count === 0) {
      inserting = true;
      await tx.pushSubscription.create({ data: { endpoint: safeEndpoint, ...keys, userId, label: sanitizedLabel } });
    }
    return "ok" as const;
  }).catch((err: unknown) => {
    if (inserting && isPrismaErrorCode(err, "P2002")) return "taken" as const;
    throw err;
  });

  if (outcome === "taken") {
    return NextResponse.json({ error: t("apiUser.push.endpointTaken") }, { status: 409 });
  }
  if (outcome === "gone") {
    // The client drops its browser subscription on this answer, so the bell
    // shows "off" instead of a device the server no longer delivers to.
    return NextResponse.json({ error: t("apiUser.push.subscriptionRemoved") }, { status: 410 });
  }
  return NextResponse.json({ ok: true });
});

// The three subscription fields, each a non-empty string, or null when any is missing.
function readSubscriptionFields(body: { endpoint?: unknown; keys?: unknown }): { endpoint: string; p256dh: string; auth: string } | null {
  const keys = body.keys !== null && typeof body.keys === "object" ? (body.keys as { p256dh?: unknown; auth?: unknown }) : null;
  const { endpoint } = body;
  const p256dh = keys?.p256dh;
  const auth = keys?.auth;
  if (typeof endpoint !== "string" || !endpoint || typeof p256dh !== "string" || !p256dh || typeof auth !== "string" || !auth) {
    return null;
  }
  return { endpoint, p256dh, auth };
}

function badRequest(t: Translator, key: string): NextResponse {
  return NextResponse.json({ error: t(key) }, { status: 400 });
}

export const DELETE = withAuth(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  const parsed = await readJsonCapped<{ endpoint?: string; id?: string }>(req, 32768);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed;

  // The device-management UI deletes by row `id` so the raw endpoint/APNs token
  // never has to be exposed to the client; the web push client self-unsubscribes
  // by its own `endpoint`. Accept either — always scoped to the caller's userId,
  // so a user can only remove their own subscriptions.
  if (typeof body.id === "string" && body.id.length > 0) {
    // A removal by id comes from the device list, not from the browser itself,
    // which still holds its subscription: tombstone it so that browser's next
    // page-load resync can't quietly re-register it.
    const userId = session.user.id;
    const id = body.id;
    await prisma.$transaction(async (tx) => {
      await lockUserPushRegistrationsInTx(tx, userId);
      const rows = await tx.pushSubscription.findMany({ where: { id, userId }, select: { endpoint: true, platform: true } });
      await tx.pushSubscription.deleteMany({ where: { id, userId } });
      await tombstoneRemovedPushRowsInTx(tx, userId, rows);
    });
    return NextResponse.json({ ok: true });
  }

  if (typeof body.endpoint !== "string" || !body.endpoint) {
    return NextResponse.json({ error: t("apiUser.push.idOrEndpointRequired") }, { status: 400 });
  }

  // Reject rather than fall back to the raw endpoint: the stored row is keyed by
  // the canonicalized endpoint, so a raw value bypasses canonicalization and
  // either no-ops or matches an unintended row. Canonicalize WITHOUT DNS, though:
  // the key is pure URL serialization, and the delete is userId-scoped, so there
  // is nothing to SSRF-check. Going through resolveToSafeUrl made a transient DNS
  // failure for the push service answer 400 and leave the opted-out row behind.
  const canonicalEndpoint = canonicalizePushEndpoint(body.endpoint);
  if (!canonicalEndpoint) {
    return NextResponse.json({ error: t("apiUser.push.endpointInvalid") }, { status: 400 });
  }

  await prisma.pushSubscription.deleteMany({
    where: { endpoint: canonicalEndpoint, userId: session.user.id },
  });

  return NextResponse.json({ ok: true });
});
