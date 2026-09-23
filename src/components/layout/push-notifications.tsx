"use client";

import { useEffect, useRef, useState } from "react";
import { Bell, BellOff, Send } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useHasMounted } from "@/hooks/use-has-mounted";
import { withBasePath } from "@/lib/base-path";

type State = "unsupported" | "loading" | "subscribed" | "unsubscribed" | "denied" | "naming";
type TestState = "idle" | "sending" | "ok" | "error";

const SW_READY_TIMEOUT_MS = 10_000;

// Several copies of this component are on the page at once: the desktop
// Header and the MobileNav are both always rendered (CSS hides one), and the
// mobile drawer adds a third while open. So that they all agree, whichever
// copy subscribes or unsubscribes fires this window event, and every copy
// re-reads the browser's subscription when it hears it. (A shared state
// library would also work, but guardrail 9 rules that out.)
const PUSH_CHANGED_EVENT = "summonarr:push-changed";

/** Reject a promise that may never settle. `serviceWorker.ready` is one. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

export function PushNotifications() {
  // Gate first render on `useHasMounted` so SSR and the first client render
  // both emit nothing — otherwise the parent's child count disagrees with the
  // SSR DOM (React #418 on /, /movies, /admin/library etc.).
  const mounted = useHasMounted();
  const [state, setState] = useState<State>("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testState, setTestState] = useState<TestState>("idle");
  const [deviceName, setDeviceName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

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
      .then((sub) => setState(sub ? "subscribed" : "unsubscribed"))
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

  useEffect(() => {
    if (state === "naming") {
      // Wait one tick so the input exists before we focus it.
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [state]);

  async function subscribe(label: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(withBasePath("/api/push/vapid-key"));
      if (!res.ok) {
        // Surface the server's reason rather than a generic one. The 503 here
        // means an incomplete VAPID keypair in Settings — an operator problem
        // the user can report, not a transient fetch failure they should retry.
        const reason = await res
          .json()
          .then((b: { error?: string }) => b?.error)
          .catch(() => undefined);
        throw new Error(reason || "Could not fetch VAPID key");
      }
      const { publicKey } = await res.json() as { publicKey: string };

      // `navigator.serviceWorker.ready` never rejects: if the service worker
      // failed to register it just waits forever. Without a timeout, `finally`
      // would never run and `busy` would stay true, leaving the bell disabled
      // for the life of the page with no error shown.
      const reg = await withTimeout(navigator.serviceWorker.ready, SW_READY_TIMEOUT_MS);
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: publicKey,
      });

      const json = sub.toJSON();
      const subscribeRes = await fetch(withBasePath("/api/push/subscribe"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys, label: label.trim() || undefined }),
      });
      if (!subscribeRes.ok) {
        // The server refused (commonly a 403 because the push feature flag
        // is off), so undo the browser-side subscription too. Otherwise the
        // browser would keep a subscription the server doesn't know about,
        // and the bell would wrongly show "subscribed" on every later visit.
        await sub.unsubscribe().catch(() => { });
        const data = (await subscribeRes.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? `Could not enable notifications (${subscribeRes.status})`);
        setState("unsubscribed");
        return;
      }

      setState("subscribed");
      window.dispatchEvent(new Event(PUSH_CHANGED_EVENT));
    } catch {
      // Same reasoning as above: if anything threw after the browser
      // subscribed, undo that subscription. Unsubscribing one that is already
      // gone is harmless.
      await navigator.serviceWorker
        .getRegistration(withBasePath("/"))
        .then((r) => r?.pushManager.getSubscription())
        .then((s) => s?.unsubscribe())
        .catch(() => { });
      const denied = Notification.permission === "denied";
      if (!denied) setError("Could not enable notifications. Please try again.");
      setState(denied ? "denied" : "unsubscribed");
    } finally {
      setBusy(false);
    }
  }

  async function sendTest() {
    setTestState("sending");
    try {
      const res = await fetch(withBasePath("/api/push/test"), { method: "POST" });
      const data = await res.json() as { results?: { ok: boolean; status?: number; message?: string; body?: string }[]; error?: string };
      if (!res.ok) {
        console.error("[push test] failed:", data);
        setTestState("error");
      } else {
        const anyFailed = data.results?.some((r) => !r.ok);
        if (anyFailed) {
          console.error("[push test] some sends failed:", data.results);
          setTestState("error");
        } else {
          setTestState("ok");
        }
      }
    } catch (err) {
      console.error("[push test] fetch error:", err);
      setTestState("error");
    } finally {
      setTimeout(() => setTestState("idle"), 3000);
    }
  }

  async function unsubscribe() {
    setBusy(true);
    setError(null);
    try {
      // Same never-settles guard as subscribe(); a timeout lands in the catch.
      const reg = await withTimeout(navigator.serviceWorker.ready, SW_READY_TIMEOUT_MS);
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await fetch(withBasePath("/api/push/subscribe"), {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
        await sub.unsubscribe();
      }
      setState("unsubscribed");
      window.dispatchEvent(new Event(PUSH_CHANGED_EVENT));
    } catch {
      setError("Could not turn off notifications. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  if (!mounted || state === "loading") return null;

  if (state === "unsupported") {
    // 32x32 icon button. The aria-label lets screen readers (VoiceOver,
    // TalkBack) announce it; a `title` alone is unreliable on mobile.
    return (
      <button
        disabled
        aria-label="Push notifications not supported"
        title="Push notifications are not supported in this browser"
        className="ds-tap inline-flex items-center justify-center cursor-not-allowed shrink-0"
        // fg-disabled, not zinc-700: zinc-700 is a background colour in this
        // theme, so the icon would vanish into the header.
        style={{ width: 32, height: 32, borderRadius: 6, color: "var(--ds-fg-disabled)" }}
      >
        <BellOff className="w-4 h-4" />
      </button>
    );
  }

  if (state === "denied") {
    return (
      <button
        disabled
        aria-label="Notifications blocked"
        title="Notifications blocked — enable them in your browser settings"
        className="ds-tap inline-flex items-center justify-center text-zinc-500 cursor-not-allowed shrink-0"
        style={{ width: 32, height: 32, borderRadius: 6 }}
      >
        <BellOff className="w-4 h-4" />
      </button>
    );
  }

  if (state === "naming") {
    return (
      <form
        className="flex items-center gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          subscribe(deviceName);
        }}
      >
        <Input
          ref={inputRef}
          type="text"
          value={deviceName}
          onChange={(e) => setDeviceName(e.target.value)}
          placeholder="Device name (e.g. Work Mac)"
          maxLength={100}
          aria-label="Device name"
          className="h-7 w-40 text-xs md:text-xs"
        />
        <Button
          type="submit"
          size="sm"
          disabled={busy}
          aria-label="Enable push notifications for this device"
        >
          Enable
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => { setState("unsubscribed"); setDeviceName(""); }}
        >
          Cancel
        </Button>
      </form>
    );
  }

  if (state === "subscribed") {
    return (
      <div className="flex items-center gap-1">
        <button
          onClick={unsubscribe}
          disabled={busy}
          // A failed unsubscribe keeps this state, so show its error here.
          aria-label={error ?? "Disable desktop notifications"}
          title={error ?? "Disable desktop notifications"}
          className={`ds-tap inline-flex items-center justify-center transition-colors disabled:opacity-50 shrink-0 ${
            error ? "text-red-400" : "text-indigo-400 hover:text-indigo-300"
          }`}
          style={{ width: 32, height: 32, borderRadius: 6 }}
        >
          <Bell className="w-4 h-4" />
        </button>
        <button
          onClick={sendTest}
          disabled={testState === "sending"}
          aria-label="Send a test notification"
          title="Send a test notification"
          className={`ds-tap inline-flex items-center justify-center transition-colors disabled:opacity-50 shrink-0 ${
            testState === "ok" ? "text-green-400" : testState === "error" ? "text-red-400" : "text-zinc-500 hover:text-zinc-300"
          }`}
          style={{ width: 32, height: 32, borderRadius: 6 }}
        >
          <Send className="w-4 h-4" />
        </button>
      </div>
    );
  }

  // This control is a 32px icon with no room for error text, so a failure
  // turns the bell red and puts the reason in its tooltip and accessible name
  // (the same way the Send-test button signals its failures).
  return (
    <button
      onClick={() => { setError(null); setState("naming"); }}
      disabled={busy}
      aria-label={error ?? "Enable desktop notifications"}
      title={error ?? "Enable desktop notifications"}
      className={`ds-tap inline-flex items-center justify-center transition-colors disabled:opacity-50 shrink-0 ${
        error ? "text-red-400 hover:text-[var(--ds-danger-hover)]" : "text-zinc-500 hover:text-zinc-300"
      }`}
      style={{ width: 32, height: 32, borderRadius: 6 }}
    >
      <BellOff className="w-4 h-4" />
    </button>
  );
}
