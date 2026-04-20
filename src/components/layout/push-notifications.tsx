"use client";

import { useEffect, useRef, useState } from "react";
import { Bell, BellOff, Send, X } from "lucide-react";

type State = "unsupported" | "loading" | "subscribed" | "unsubscribed" | "denied" | "naming";
type TestState = "idle" | "sending" | "ok" | "error";

export function PushNotifications() {
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

  if (state === "loading") return null;

  if (state === "unsupported") {
    return (
      <button
        disabled
        title="Push notifications are not supported in this browser"
        className="flex items-center gap-1.5 text-xs text-zinc-700 cursor-not-allowed"
      >
        <BellOff className="w-4 h-4" />
      </button>
    );
  }

  if (state === "denied") {
    return (
      <button
        disabled
        title="Notifications blocked — enable them in your browser settings"
        className="flex items-center gap-1.5 text-xs text-zinc-600 cursor-not-allowed"
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
          className="text-xs text-indigo-400 hover:text-indigo-300 disabled:opacity-50 transition-colors"
        >
          Enable
        </button>
        <button
          type="button"
          onClick={() => { setState("unsubscribed"); setDeviceName(""); }}
          className="text-zinc-500 hover:text-zinc-300 transition-colors"
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
          title="Disable desktop notifications"
          className="flex items-center gap-1.5 text-xs text-indigo-400 hover:text-indigo-300 transition-colors disabled:opacity-50"
        >
          <Bell className="w-4 h-4" />
        </button>
        <button
          onClick={sendTest}
          disabled={testState === "sending"}
          title="Send a test notification"
          className={`flex items-center text-xs transition-colors disabled:opacity-50 ${
            testState === "ok" ? "text-green-400" : testState === "error" ? "text-red-400" : "text-zinc-500 hover:text-zinc-300"
          }`}
        >
          <Send className="w-3.5 h-3.5" />
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={() => setState("naming")}
      disabled={busy}
      title="Enable desktop notifications"
      className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-300 transition-colors disabled:opacity-50"
    >
      <BellOff className="w-4 h-4" />
    </button>
  );
}
