"use client";

import { useEffect, useRef, useState } from "react";
import { Bell, BellOff, Send, X } from "@/components/icons";
import { useHasMounted } from "@/hooks/use-has-mounted";
import { withBasePath } from "@/lib/base-path";

type State = "unsupported" | "loading" | "subscribed" | "unsubscribed" | "denied" | "naming";
type TestState = "idle" | "sending" | "ok" | "error";

const SW_READY_TIMEOUT_MS = 10_000;

// Two instances of this component are mounted on EVERY page at EVERY viewport:
// (app)/layout renders both <Header> and <MobileNav> unconditionally and hides
// one with CSS, not with a React gate. A third appears while the mobile drawer
// is open. Each kept its own useState and read the browser exactly once, at its
// own mount — so subscribing in one left the others showing an unsubscribed
// bell, and unsubscribing left them showing an enabled bell above a Send-test
// button that now answers 404. A shared store would be the obvious fix and is
// exactly what guardrail 9 rules out, so: one window event, and every instance
// re-reads the browser when it fires.
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
        .then((sub) => setState(sub ? "subscribed" : "unsubscribed"))
        .catch(() => { });
    };
    window.addEventListener(PUSH_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(PUSH_CHANGED_EVENT, onChanged);
  }, []);

  useEffect(() => {
    if (state === "naming") {
      // Defer focus by one tick so the input is mounted before focus is called
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [state]);

  async function subscribe(label: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(withBasePath("/api/push/vapid-key"));
      if (!res.ok) throw new Error("Could not fetch VAPID key");
      const { publicKey } = await res.json() as { publicKey: string };

      // `navigator.serviceWorker.ready` never rejects — it simply never settles
      // when there is no active registration for this scope, and the register()
      // failure in the mount effect above is swallowed into "unsubscribed",
      // which still renders the Enable button. So a failed registration parked
      // this await forever, `finally` never ran, and `busy` stayed true — which
      // does not just disable the naming form's Enable button but the main bell
      // button too, for the life of the page, with no error shown anywhere.
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
        // Hand the browser subscription back. Keeping it means the browser
        // holds a live push subscription that the server has no row for: no
        // push can ever arrive, yet the mount effect reads getSubscription() and
        // reports "subscribed" on every later visit. The everyday cause is
        // mundane — the push feature flag being off answers 403 — so this is
        // not a rare path.
        await sub.unsubscribe().catch(() => { });
        const data = (await subscribeRes.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? `Could not enable notifications (${subscribeRes.status})`);
        setState("unsubscribed");
        return;
      }

      setState("subscribed");
      window.dispatchEvent(new Event(PUSH_CHANGED_EVENT));
    } catch {
      // Same reasoning as above: anything that threw after subscribe() resolved
      // leaves an orphan, and unsubscribing an already-dead subscription is
      // harmless.
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
      const reg = await navigator.serviceWorker.ready;
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
    // Icon button — 32x32 hit area + aria-label so VoiceOver/TalkBack announce
    // purpose (title alone is unreliable on mobile).
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

  // This control is a 32px icon in a header — there is nowhere to put a line of
  // error text. So a failure tints the bell and moves the reason into the
  // tooltip and the accessible name, matching how the Send-test button already
  // signals its own failures. Previously a rejected subscribe (a 403 because
  // the push feature flag is off is the common one) just snapped back to the
  // plain bell, saying nothing at all.
  return (
    <button
      onClick={() => { setError(null); setState("naming"); }}
      disabled={busy}
      aria-label={error ?? "Enable desktop notifications"}
      title={error ?? "Enable desktop notifications"}
      className={`ds-tap inline-flex items-center justify-center transition-colors disabled:opacity-50 shrink-0 ${
        error ? "text-red-400 hover:text-red-300" : "text-zinc-500 hover:text-zinc-300"
      }`}
      style={{ width: 32, height: 32, borderRadius: 6 }}
    >
      <BellOff className="w-4 h-4" />
    </button>
  );
}
