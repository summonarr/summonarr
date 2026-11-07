import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { checkRateLimit, parseRateLimit } from "@/lib/rate-limit";
import { resolveToSafeUrl } from "@/lib/ssrf";
import { encryptToken } from "@/lib/token-crypto";
import { sanitizeText } from "@/lib/sanitize";
import { readJsonCapped } from "@/lib/body-size";
import { isFeatureEnabled } from "@/lib/features";
import { maintenanceGuard } from "@/lib/maintenance";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import {
  clearPushEndpointRemovalInTx,
  countUserPushRegistrationsInTx,
  evictOldestForCapInTx,
  isPushEndpointRemovedInTx,
  lockUserPushRegistrationsInTx,
  tombstoneRemovedPushRowsInTx,
} from "@/lib/push-registration";

const DEFAULT_MAX_PUSH_SUBSCRIPTIONS = 5;

// The same canonical string resolveToSafeUrlWithAddrs ([ssrf.ts]) returns for a
// safe URL — serialize, then collapse ONLY the bare-origin trailing slash — minus
// the DNS resolve. Keep the two in step or unsubscribe misses the stored key.
function canonicalizePushEndpoint(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const serialized = url.toString();
  const isBareOrigin = url.pathname === "/" && !url.search && !url.hash;
  return isBareOrigin ? serialized.replace(/\/$/, "") : serialized;
}

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

  const parsed = await readJsonCapped<{ endpoint?: string; keys?: { p256dh?: string; auth?: string }; label?: string; resync?: unknown }>(req, 32768);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed;

  const { endpoint, keys, label } = body;
  // The bell's once-per-page-load re-send of a subscription the browser already
  // holds (push-notifications.tsx), as opposed to the user turning push on. It
  // may restore a row the server lost — the 6g sign-out/password wipe deletes
  // every registration — but never one that was removed on purpose.
  const resync = body.resync === true;
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return NextResponse.json({ error: t("apiUser.push.fieldsRequired") }, { status: 400 });
  }
  const p256dh = keys.p256dh;
  const auth = keys.auth;

  // Cheap field-length checks first — no DNS, no DB. Doing this before
  // resolveToSafeUrl avoids resolving a 64KB attacker-controlled URL.
  if (endpoint.length > 2048 || p256dh.length > 256 || auth.length > 256) {
    return NextResponse.json({ error: t("apiUser.push.fieldsTooLong") }, { status: 400 });
  }

  // Allowlist known push services before DNS resolution to prevent SSRF via push endpoint registration
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "https:") {
      return NextResponse.json({ error: t("apiUser.push.endpointHttps") }, { status: 400 });
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
      return NextResponse.json({ error: t("apiUser.push.endpointUnrecognized") }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: t("apiUser.push.endpointInvalidUrl") }, { status: 400 });
  }

  const safeEndpoint = await resolveToSafeUrl(endpoint);
  if (!safeEndpoint) {
    return NextResponse.json({ error: t("apiUser.push.endpointDisallowed") }, { status: 400 });
  }

  const capRow = await prisma.setting.findUnique({ where: { key: "maxPushSubscriptions" } });
  const cap = parseRateLimit(capRow?.value, DEFAULT_MAX_PUSH_SUBSCRIPTIONS);

  // sanitizeText also strips control chars and Unicode bidi-overrides, which
  // matters because labels get captured by the audit log (auditContext bundles
  // user-controlled strings into `details`) — a bidi-override would otherwise
  // let a user spoof apparent identity in audit-table views.
  // typeof-guard BEFORE the string method — the parsed body is untyped at
  // runtime, so a numeric `label` threw on .replace and returned a 500.
  const sanitizedLabel = typeof label === "string" && label
    ? (sanitizeText(label).slice(0, 100) || undefined)
    : undefined;

  // Ownership, cap and write in one transaction under the per-user lock
  // (push-registration.ts), so two concurrent registrations can't both pass the
  // count and leave the user one over the cap. Statements run one at a time and
  // nothing inside is caught (guardrails 23, 23c).
  const userId = session.user.id;
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

    await tx.pushSubscription.upsert({
      where: { endpoint: safeEndpoint },
      update: { p256dh: encryptToken(p256dh), auth: encryptToken(auth), ...(sanitizedLabel !== undefined && { label: sanitizedLabel }) },
      create: { endpoint: safeEndpoint, p256dh: encryptToken(p256dh), auth: encryptToken(auth), userId, label: sanitizedLabel },
    });
    return "ok" as const;
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
