import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { decryptToken } from "@/lib/token-crypto";
import { sendPushNotification } from "@/lib/web-push";

export const POST = withAuth(async (_req, _ctx, session) => {
  const keys = await prisma.setting.findMany({
    where: { key: { in: ["vapidPublicKey", "vapidPrivateKey", "smtpFrom", "smtpUser"] } },
  });
  const cfg = Object.fromEntries(keys.map((r) => [r.key, r.value]));

  if (!cfg.vapidPublicKey || !cfg.vapidPrivateKey) {
    return NextResponse.json({ error: "VAPID keys not found in DB — subscribe to push first to generate them" }, { status: 500 });
  }

  const vapidContact = `mailto:${cfg.smtpFrom || cfg.smtpUser || "admin@localhost"}`;

  const subs = await prisma.pushSubscription.findMany({
    where: { userId: session.user.id },
  });

  if (!subs.length) {
    return NextResponse.json({ error: "No push subscription found for your account — try unsubscribing and re-subscribing" }, { status: 404 });
  }

  // This route tests Web Push (VAPID) only. Native (iOS/APNs) rows carry a
  // deviceToken with null p256dh/auth and are delivered via the relay, not here.
  type WebSub = (typeof subs)[number] & { p256dh: string; auth: string };
  const webSubs = subs.filter((s): s is WebSub => s.p256dh !== null && s.auth !== null);
  if (!webSubs.length) {
    return NextResponse.json({ error: "No web push subscription to test — this account only has native app push registered." }, { status: 404 });
  }

  const results = await Promise.all(
    webSubs.map(async (sub) => {
      try {
        await sendPushNotification(
          {
            endpoint: sub.endpoint,
            keys: {
              p256dh: decryptToken(sub.p256dh, "PushSubscription.p256dh"),
              auth: decryptToken(sub.auth, "PushSubscription.auth"),
            },
          },
          JSON.stringify({ title: "Summonarr", body: "Test notification — push is working!", url: "/" }),
          {
            contact: vapidContact,
            vapidPublicKey: cfg.vapidPublicKey,
            vapidPrivateKey: cfg.vapidPrivateKey,
          },
        );
        return { endpoint: sub.endpoint.slice(0, 40) + "…", ok: true };
      } catch (err: unknown) {
        const e = err as { statusCode?: number; message?: string; body?: string };
        return {
          endpoint: sub.endpoint.slice(0, 40) + "…",
          ok: false,
          status: e.statusCode,
          message: e.message,
          body: e.body,
        };
      }
    })
  );

  const allOk = results.every((r) => r.ok);
  return NextResponse.json({ results }, { status: allOk ? 200 : 502 });
});
