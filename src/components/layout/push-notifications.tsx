"use client";

import { useEffect, useRef, useState } from "react";
import { Bell, BellOff, Send, X } from "lucide-react";
import { useHasMounted } from "@/hooks/use-has-mounted";

type State = "unsupported" | "loading" | "subscribed" | "unsubscribed" | "denied" | "naming";
type TestState = "idle" | "sending" | "ok" | "error";

export function PushNotifications() {
  // Gate first render on `useHasMounted` so SSR and the first client render
  // both emit nothing. Without this, the parent's child count can disagree
  // with the SSR DOM (canonical React #418 source on /, /movies, /admin/library
  // etc.) — we observed the parent receiving an extra <div> child between
  // hydration and useEffect resolution.
  const mounted = useHasMounted();
  const [state, setState] = useState<State>("loading");
  const [busy, setBusy] = useState(false);
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
      .register("/sw.js")
      .then((reg) => reg.pushManager.getSubscription())
      .then((sub) => setState(sub ? "subscribed" : "unsubscribed"))
      .catch(() => setState("unsubscribed"));
  }, []);

  useEffect(() => {
    if (state === "naming") {
      // Defer focus by one tick so the input is mounted before focus is called
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [state]);

  async function subscribe(label: string) {
    setBusy(true);
    try {
      const res = await fetch("/api/push/vapid-key");
      if (!res.ok) throw new Error("Could not fetch VAPID key");
      const { publicKey } = await res.json() as { publicKey: string };

      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: publicKey,
      });

      const json = sub.toJSON();
      const subscribeRes = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys, label: label.trim() || undefined }),
      });
      if (!subscribeRes.ok) {
        setState("unsubscribed");
        return;
      }

      setState("subscribed");
    } catch {
      setState(Notification.permission === "denied" ? "denied" : "unsubscribed");
    } finally {
      setBusy(false);
    }
  }

  async function sendTest() {
    setTestState("sending");
    try {
      const res = await fetch("/api/push/test", { method: "POST" });
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
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await fetch("/api/push/subscribe", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
        await sub.unsubscribe();
      }
      setState("unsubscribed");
    } catch {

    } finally {
      setBusy(false);
    }
  }

  if (!mounted || state === "loading") return null;

  if (state === "unsupported") {
    // Mobile audit F-1.9: chrome icon button — 32x32 hit area + aria-label so
    // VoiceOver/TalkBack announce purpose (title alone is unreliable on mobile).
    return (
      <button
        disabled
        aria-label="Push notifications not supported"
        title="Push notifications are not supported in this browser"
        className="ds-tap inline-flex items-center justify-center text-zinc-700 cursor-not-allowed shrink-0"
        style={{ width: 32, height: 32, borderRadius: 6 }}
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
        className="ds-tap inline-flex items-center justify-center text-zinc-600 cursor-not-allowed shrink-0"
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
        <input
          ref={inputRef}
          type="text"
          value={deviceName}
          onChange={(e) => setDeviceName(e.target.value)}
          placeholder="Device name (e.g. Work Mac)"
          maxLength={100}
          className="h-6 w-40 rounded border border-zinc-700 bg-zinc-800 px-2 text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
        />
        <button
          type="submit"
          disabled={busy}
          aria-label="Enable push notifications for this device"
          className="text-xs text-indigo-400 hover:text-indigo-300 disabled:opacity-50 transition-colors"
        >
          Enable
        </button>
        <button
          type="button"
          onClick={() => { setState("unsubscribed"); setDeviceName(""); }}
          aria-label="Cancel"
          className="ds-tap inline-flex items-center justify-center text-zinc-500 hover:text-zinc-300 transition-colors shrink-0"
          style={{ width: 28, height: 28 }}
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </form>
    );
  }

  if (state === "subscribed") {
    return (
      <div className="flex items-center gap-1">
        <button
          onClick={unsubscribe}
          disabled={busy}
          aria-label="Disable desktop notifications"
          title="Disable desktop notifications"
          className="ds-tap inline-flex items-center justify-center text-indigo-400 hover:text-indigo-300 transition-colors disabled:opacity-50 shrink-0"
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

  return (
    <button
      onClick={() => setState("naming")}
      disabled={busy}
      aria-label="Enable desktop notifications"
      title="Enable desktop notifications"
      className="ds-tap inline-flex items-center justify-center text-zinc-500 hover:text-zinc-300 transition-colors disabled:opacity-50 shrink-0"
      style={{ width: 32, height: 32, borderRadius: 6 }}
    >
      <BellOff className="w-4 h-4" />
    </button>
  );
}
