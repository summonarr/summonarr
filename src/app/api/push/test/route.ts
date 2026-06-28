import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { decryptToken } from "@/lib/token-crypto";
import { sendPushNotification } from "@/lib/web-push";
import { sendApnsTestToUser } from "@/lib/push";
import { checkRateLimit } from "@/lib/rate-limit";

type TestResult = {
  platform: "ios" | "web";
  endpoint: string;
  ok: boolean;
  status?: number;
  message?: string;
};

// Fires a real test notification to every device registered to the caller —
// iOS (APNs, through the central relay + the same E2E path production push uses)
// and Web Push (VAPID) alike — and reports a per-device result. This is the
// manual diagnostic behind the "Send test notification" button; it bypasses the
// `feature.integration.push` flag and per-event preferences so the pipeline can
// be verified before either is configured.
export const POST = withAuth(async (_req, _ctx, session) => {
  if (!checkRateLimit(`push-test:${session.user.id}`, 5, 60_000)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const subs = await prisma.pushSubscription.findMany({
    where: { userId: session.user.id },
  });
  if (!subs.length) {
    return NextResponse.json(
      { error: "No push subscription found for your account — register the app or subscribe in a browser first." },
      { status: 404 },
    );
  }

  const results: TestResult[] = [];

  // ── iOS (APNs via the central relay) ──
  if (subs.some((s) => s.platform === "ios")) {
    const ios = await sendApnsTestToUser(session.user.id);
    results.push(...ios.map((r) => ({ platform: "ios" as const, endpoint: r.endpoint, ok: r.ok })));
  }

  // ── Web Push (VAPID) ── rows carry p256dh/auth; iOS rows leave them null.
  const webSubs = subs.filter(
    (s): s is typeof s & { p256dh: string; auth: string } => s.p256dh !== null && s.auth !== null,
  );
  if (webSubs.length) {
    const keyRows = await prisma.setting.findMany({
      where: { key: { in: ["vapidPublicKey", "vapidPrivateKey", "smtpFrom", "smtpUser"] } },
    });
    const cfg = Object.fromEntries(keyRows.map((r) => [r.key, r.value]));
    if (!cfg.vapidPublicKey || !cfg.vapidPrivateKey) {
      results.push(
        ...webSubs.map((s): TestResult => ({
          platform: "web",
          endpoint: s.endpoint.slice(0, 28) + "…",
          ok: false,
          message: "VAPID keys not configured",
        })),
      );
    } else {
      const vapidContact = `mailto:${cfg.smtpFrom || cfg.smtpUser || "admin@localhost"}`;
      const webResults = await Promise.all(
        webSubs.map(async (sub): Promise<TestResult> => {
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
              { contact: vapidContact, vapidPublicKey: cfg.vapidPublicKey, vapidPrivateKey: cfg.vapidPrivateKey },
            );
            return { platform: "web", endpoint: sub.endpoint.slice(0, 28) + "…", ok: true };
          } catch (err: unknown) {
            const e = err as { statusCode?: number; message?: string };
            return {
              platform: "web",
              endpoint: sub.endpoint.slice(0, 28) + "…",
              ok: false,
              status: e.statusCode,
              message: e.message,
            };
          }
        }),
      );
      results.push(...webResults);
    }
  }

  const allOk = results.length > 0 && results.every((r) => r.ok);
  return NextResponse.json({ results }, { status: allOk ? 200 : 502 });
});
