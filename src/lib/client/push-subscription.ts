// This browser's web-push registration: the requests the push bell sends and
// the browser calls they pair with. No React, so the unit suite drives the
// request halves with a stubbed fetch (tests/push-subscription-client.test.mts).
import { withBasePath } from "@/lib/base-path";
import { fetchJson, jsonInit } from "@/lib/client/fetch-json";
import { v } from "@/lib/validate";

export const SW_READY_TIMEOUT_MS = 10_000;

// Several copies of the push bell are on the page at once: the desktop Header
// and the MobileNav are both always rendered (CSS hides one), and the mobile
// drawer adds a third while open. So that they all agree, whichever copy
// subscribes or unsubscribes fires this window event, and every copy re-reads
// the browser's subscription when it hears it. (A shared state library would
// also work, but guardrail 9 rules that out.)
export const PUSH_CHANGED_EVENT = "summonarr:push-changed";

export function announcePushChange(): void {
  window.dispatchEvent(new Event(PUSH_CHANGED_EVENT));
}

// The server can drop this browser's registration without the browser knowing:
// a password change or "sign out everywhere" deletes every push registration on
// the account, since a session hijacker may have added their own (guardrail 6g).
// The bell reads the BROWSER's subscription, so without this the owner's own
// browser would keep showing "on" while nothing was delivered. Re-send it once
// per page load, flagged `resync`; the server upserts by endpoint, so a
// still-registered browser changes nothing.
//
// A resync never undoes a removal made on purpose — the profile's "Remove
// device", or the per-user cap evicting this browser for a newer one — and never
// evicts another device. The server answers those with 410, and this browser
// then drops its own subscription so the bell shows "off". Other failures are
// ignored: push may be switched off, the site may be in maintenance, or the
// endpoint may belong to another account here.
let resyncedThisPageLoad = false;
export function resyncSubscription(sub: PushSubscription): Promise<void> {
  if (resyncedThisPageLoad) return Promise.resolve();
  resyncedThisPageLoad = true;
  const json = sub.toJSON();
  return fetchJson(withBasePath("/api/push/subscribe"), {
    init: jsonInit("POST", { endpoint: json.endpoint, keys: json.keys, resync: true }),
  })
    .then(async (res) => {
      if (res.ok || res.kind !== "http" || res.status !== 410) return;
      await sub.unsubscribe().catch(() => false);
      announcePushChange();
    })
    .catch(() => {});
}

/** Lets a test start a fresh "page load". */
export function resetResyncForTests(): void {
  resyncedThisPageLoad = false;
}

// Best-effort removal of this browser's server row by endpoint. Used when a
// subscribe failed after its POST may have been stored (a lost response): the
// row would otherwise count toward the per-user cap until a send got a 410.
export async function forgetEndpoint(endpoint: string): Promise<void> {
  await fetchJson(withBasePath("/api/push/subscribe"), { init: jsonInit("DELETE", { endpoint }) });
}

/** The server's own (translated, safe) reason the VAPID key could not be served. */
export class ServerReasonError extends Error {}

/** Reject a promise that may never settle. `serviceWorker.ready` is one. */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

const VapidKeySchema = v.object({ publicKey: v.string() });

// The VAPID public key. A refusal carries the server's reason (the 503 means an
// incomplete VAPID keypair in Settings — an operator problem the user can
// report, not a transient fetch failure they should retry), and a missing or
// empty key is reported as one too: handed to the browser, it fails inside
// subscribe() with a message that says nothing about the cause.
export async function fetchVapidKey(vapidFailed: string): Promise<string> {
  const res = await fetchJson(withBasePath("/api/push/vapid-key"), { schema: VapidKeySchema, fallbackError: vapidFailed });
  if (res.ok) {
    if (res.data.publicKey.trim()) return res.data.publicKey;
    throw new ServerReasonError(vapidFailed);
  }
  if (res.kind === "http" || res.kind === "invalid") throw new ServerReasonError(res.error);
  throw new Error(`vapid key: ${res.detail}`);
}

export interface PushPrepared {
  publicKey: string;
  reg: ServiceWorkerRegistration;
}

// Everything subscribe() needs before the browser's permission prompt: the key
// and the ready service worker. Fetched when the device-name form opens, so the
// submit calls pushManager.subscribe at once, inside the click. Firefox and
// Safari show the prompt only for a recent user gesture, and a slow key fetch
// or a cold service worker could outlast it.
//
// `navigator.serviceWorker.ready` never rejects: if the service worker failed
// to register it just waits forever, so it is bounded here.
export function preparePush(vapidFailed: string): Promise<PushPrepared> {
  return Promise.all([
    fetchVapidKey(vapidFailed),
    withTimeout(navigator.serviceWorker.ready, SW_READY_TIMEOUT_MS),
  ]).then(([publicKey, reg]) => ({ publicKey, reg }));
}

export type RegisterOutcome =
  | { kind: "ok" }
  // The route answered and refused (403 with push switched off, 409, 410…).
  | { kind: "refused"; status: number; error: string }
  // No answer: the row may or may not have been stored.
  | { kind: "no-answer" };

/** POSTs a new subscription with the device's label. */
export async function registerSubscription(sub: PushSubscription, label: string): Promise<RegisterOutcome> {
  const json = sub.toJSON();
  const res = await fetchJson(withBasePath("/api/push/subscribe"), {
    init: jsonInit("POST", { endpoint: json.endpoint, keys: json.keys, label: label.trim() || undefined }),
  });
  // A 2xx stored the row, whatever its body says.
  if (res.ok || res.kind === "invalid") return { kind: "ok" };
  if (res.kind === "http") return { kind: "refused", status: res.status, error: res.error };
  return { kind: "no-answer" };
}

/**
 * DELETEs this browser's row. True when the server no longer holds it: a 404
 * means it had already forgotten it. Anything else leaves the server still
 * pushing to the endpoint.
 */
export async function unregisterSubscription(endpoint: string): Promise<boolean> {
  const res = await fetchJson(withBasePath("/api/push/subscribe"), { init: jsonInit("DELETE", { endpoint }) });
  return res.ok || res.kind === "invalid" || (res.kind === "http" && res.status === 404);
}

export type EnableOutcome =
  | { kind: "subscribed" }
  // The route refused; the browser-side subscription has been undone.
  | { kind: "refused"; status: number; error: string }
  // Anything else. `reason` is the server's own reason when it gave one.
  | { kind: "failed"; reason: string | null };

// Subscribes this browser and registers it with the server. Only the
// subscription THIS call obtained is ever rolled back: a failure before the
// browser subscribed (the key fetch, the service worker) must not touch a
// subscription that was already there.
export async function enablePush(ready: Promise<PushPrepared>, label: string): Promise<EnableOutcome> {
  let created: PushSubscription | null = null;
  try {
    const { publicKey, reg } = await ready;
    created = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: publicKey });
    const outcome = await registerSubscription(created, label);
    if (outcome.kind === "refused") {
      // The server refused (commonly a 403 because the push feature flag is
      // off), so undo the browser-side subscription too. Otherwise the browser
      // would keep a subscription the server doesn't know about, and the bell
      // would wrongly show "subscribed" on every later visit.
      await created.unsubscribe().catch(() => false);
      return outcome;
    }
    if (outcome.kind === "no-answer") throw new Error("push subscribe: no answer");
    return { kind: "subscribed" };
  } catch (err) {
    // Anything that failed after the browser subscribed undoes that
    // subscription — on the server too, since a POST whose response was lost
    // may have stored it. Removing one that is already gone is harmless on
    // both sides.
    if (created) {
      await forgetEndpoint(created.endpoint);
      await created.unsubscribe().catch(() => false);
    }
    return { kind: "failed", reason: err instanceof ServerReasonError ? err.message : null };
  }
}

// Unregisters this browser, server first. False leaves everything as it was:
// a failed DELETE leaves the server still pushing to this endpoint, and
// dropping the browser subscription anyway would show "off" while the server
// disagrees. The service worker wait has the same never-settles bound as
// preparePush().
export async function disablePush(): Promise<boolean> {
  try {
    const reg = await withTimeout(navigator.serviceWorker.ready, SW_READY_TIMEOUT_MS);
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      if (!(await unregisterSubscription(sub.endpoint))) return false;
      await sub.unsubscribe();
    }
    return true;
  } catch {
    return false;
  }
}

const TestResultsSchema = v.object({
  results: v.optional(
    v.array(
      v.object({
        ok: v.boolean(),
        platform: v.optional(v.string()),
        status: v.optional(v.number()),
        message: v.optional(v.string()),
      }),
    ),
  ),
});

/** Sends a test notification to every device on the account; true when every send went out. */
export async function sendTestPush(): Promise<boolean> {
  const res = await fetchJson(withBasePath("/api/push/test"), { init: { method: "POST" }, schema: TestResultsSchema });
  if (!res.ok) {
    console.error("[push test] failed:", res.kind, res.status, res.body ?? res.detail);
    return false;
  }
  const failed = (res.data.results ?? []).filter((r) => !r.ok);
  if (failed.length > 0) {
    console.error("[push test] some sends failed:", failed);
    return false;
  }
  return true;
}
