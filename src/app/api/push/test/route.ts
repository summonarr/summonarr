import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import webpush from "web-push";

export async function POST() {
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;

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

  webpush.setVapidDetails(vapidContact, cfg.vapidPublicKey, cfg.vapidPrivateKey);

  const results = await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          JSON.stringify({ title: "Summonarr", body: "Test notification — push is working!", url: "/" })
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
}
