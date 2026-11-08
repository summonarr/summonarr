import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { decryptToken } from "@/lib/token-crypto";
import { WebPushError, sendPushNotification } from "@/lib/web-push";
import { SafeFetchError } from "@/lib/safe-fetch";
import { sendApnsTestToUser, buildVapidContact } from "@/lib/push";
import { checkRateLimit } from "@/lib/rate-limit";
import { translatorForRequest, translatorForUser } from "@/lib/i18n/server-locale";
import type { Translator } from "@/lib/i18n/translate";

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
export const POST = withAuth(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  if (!checkRateLimit(`push-test:${session.user.id}`, 5, 60_000)) {
    return NextResponse.json({ error: t("apiUser.common.tooManyRequests") }, { status: 429 });
  }

  // The user's stored locale rides along so the test push is written in the
  // recipient's language, like every real notification.
  const subs = await prisma.pushSubscription.findMany({
    where: { userId: session.user.id },
    include: { user: { select: { locale: true } } },
  });
  if (!subs.length) {
    return NextResponse.json(
      { error: t("apiUser.push.noSubscription") },
      { status: 404 },
    );
  }

  const results: TestResult[] = [];
  if (subs.some((s) => s.platform === "ios")) {
    const ios = await sendApnsTestToUser(session.user.id);
    for (const r of ios) results.push({ platform: "ios", endpoint: r.endpoint, ok: r.ok });
  }
  // Web rows carry p256dh/auth; iOS rows leave them null.
  const webSubs = subs.filter(
    (s): s is typeof s & { p256dh: string; auth: string } => s.p256dh !== null && s.auth !== null,
  );
  // The push itself is in the recipient's language; the response is in the caller's.
  for (const r of await testWebSubscriptions(webSubs, t, translatorForUser(subs[0].user))) results.push(r);

  const allOk = results.length > 0 && results.every((r) => r.ok);
  return NextResponse.json({ results }, { status: allOk ? 200 : 502 });
});

// The endpoint as a result names it: a push-service URL is a delivery
// capability for that browser, so only its first characters are shown.
function displayEndpoint(endpoint: string): string {
  return endpoint.slice(0, 28) + "…";
}

// One VAPID test push per web subscription. With no VAPID keys configured every
// row reports so, with no network call.
async function testWebSubscriptions(
  webSubs: ReadonlyArray<{ endpoint: string; p256dh: string; auth: string }>,
  t: Translator,
  tUser: Translator,
): Promise<TestResult[]> {
  if (webSubs.length === 0) return [];
  const keyRows = await prisma.setting.findMany({
    where: { key: { in: ["vapidPublicKey", "vapidPrivateKey", "smtpFrom", "smtpUser"] } },
  });
  const cfg = Object.fromEntries(keyRows.map((r) => [r.key, r.value]));
  if (!cfg.vapidPublicKey || !cfg.vapidPrivateKey) {
    return webSubs.map((s): TestResult => ({
      platform: "web",
      endpoint: displayEndpoint(s.endpoint),
      ok: false,
      message: t("apiUser.push.vapidMissing"),
    }));
  }
  const keys = { contact: buildVapidContact(cfg.smtpFrom, cfg.smtpUser), vapidPublicKey: cfg.vapidPublicKey, vapidPrivateKey: cfg.vapidPrivateKey };
  const payload = JSON.stringify({ title: "Summonarr", body: tUser("notify.push.apnsBody.test"), url: "/" });
  return Promise.all(
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
          payload,
          keys,
        );
        return { platform: "web", endpoint: displayEndpoint(sub.endpoint), ok: true };
      } catch (err: unknown) {
        return { platform: "web", endpoint: displayEndpoint(sub.endpoint), ok: false, ...webFailure(err, t) };
      }
    }),
  );
}

// What a failed web send reports. A transport failure's message quotes the
// subscription's full endpoint URL (and on some paths its resolved address) —
// the very value every result truncates — so it becomes a fixed phrase. A push
// service's refusal keeps its status.
function webFailure(err: unknown, t: Translator): { status?: number; message?: string } {
  if (err instanceof SafeFetchError) return { message: t("apiUser.common.couldNotConnect", { service: "Web Push" }) };
  if (err instanceof WebPushError) return { status: err.statusCode, message: err.message };
  return { message: err instanceof Error ? err.message : String(err) };
}
