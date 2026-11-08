"use client";

import { useEffect, useRef, useState } from "react";
import { withBasePath } from "@/lib/base-path";
import { useT } from "@/components/i18n/i18n-provider";
import { useToast } from "@/components/ui/toast";
import {
  PUSH_CHANGED_EVENT,
  announcePushChange,
  disablePush,
  enablePush,
  preparePush,
  resyncSubscription,
  sendTestPush,
  type PushPrepared,
} from "@/lib/client/push-subscription";

export type PushState = "unsupported" | "loading" | "subscribed" | "unsubscribed" | "denied" | "naming";
export type PushTestState = "idle" | "sending" | "ok" | "error";

const TEST_RESULT_MS = 3000;

// The push bell's state machine: what the browser supports and holds, the
// device-name step, and the enable / disable / test flows. One `busy` flag is
// right here: enable and disable are never both offered (the state picks one),
// and the bell is disabled while either runs.
export function usePushNotifications() {
  const t = useT();
  const { toast } = useToast();
  const [state, setState] = useState<PushState>("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testState, setTestState] = useState<PushTestState>("idle");
  // The key + service worker, fetched when the name form opens (preparePush).
  const prepared = useRef<Promise<PushPrepared> | null>(null);
  const testResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
      setState("unsupported");
      return;
    }

    if (Notification.permission === "denied") {
      setState("denied");
      return;
    }

    navigator.serviceWorker
      .register(withBasePath("/sw.js"), { scope: withBasePath("/") })
      .then((reg) => reg.pushManager.getSubscription())
      .then((sub) => {
        if (sub) void resyncSubscription(sub);
        setState(sub ? "subscribed" : "unsubscribed");
      })
      .catch(() => setState("unsubscribed"));

    const onChanged = () => {
      navigator.serviceWorker
        .getRegistration(withBasePath("/"))
        .then((reg) => reg?.pushManager.getSubscription() ?? null)
        .then((sub) => {
          // Another copy changed the subscription, so any error this copy
          // was showing is out of date.
          setError(null);
          setState(sub ? "subscribed" : "unsubscribed");
        })
        .catch(() => { });
    };
    window.addEventListener(PUSH_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(PUSH_CHANGED_EVENT, onChanged);
  }, []);

  useEffect(() => () => { if (testResetRef.current) clearTimeout(testResetRef.current); }, []);

  // The bell turns red with the reason as its tooltip and description, but a
  // tooltip never shows on a touch screen and nothing announces it, so the same
  // reason also goes out as an error toast: visible text, announced (role=alert).
  function fail(message: string) {
    setError(message);
    toast({ title: message, variant: "error" });
  }

  function startNaming() {
    setError(null);
    setState("naming");
    const ready = preparePush(t("shared.push.vapidFailed"));
    // A failure is reported when the form is submitted, not here.
    ready.catch(() => {});
    prepared.current = ready;
  }

  function cancelNaming() {
    prepared.current = null;
    setState("unsubscribed");
  }

  async function subscribe(label: string) {
    setBusy(true);
    setError(null);
    const ready = prepared.current ?? preparePush(t("shared.push.vapidFailed"));
    prepared.current = null;
    const outcome = await enablePush(ready, label);
    if (outcome.kind === "subscribed") {
      setState("subscribed");
      announcePushChange();
    } else if (outcome.kind === "refused") {
      fail(outcome.error || t("shared.push.enableFailedStatus", { status: outcome.status }));
      setState("unsubscribed");
    } else {
      const denied = Notification.permission === "denied";
      if (!denied) fail(outcome.reason ?? t("shared.push.enableFailed"));
      setState(denied ? "denied" : "unsubscribed");
    }
    setBusy(false);
  }

  async function sendTest() {
    setTestState("sending");
    const ok = await sendTestPush();
    setTestState(ok ? "ok" : "error");
    if (testResetRef.current) clearTimeout(testResetRef.current);
    testResetRef.current = setTimeout(() => setTestState("idle"), TEST_RESULT_MS);
  }

  async function unsubscribe() {
    setBusy(true);
    setError(null);
    if (await disablePush()) {
      setState("unsubscribed");
      announcePushChange();
    } else {
      fail(t("shared.push.disableFailed"));
    }
    setBusy(false);
  }

  return { state, busy, error, testState, startNaming, cancelNaming, subscribe, unsubscribe, sendTest };
}
