// Radarr/Sonarr Health / HealthRestored webhook events → the admin's outbound
// notification channels (webhook / ntfy / Gotify — guardrail 14c: reached ONLY
// through emitNotificationEvent, which never throws and never blocks).
//
// Radarr/Sonarr send a health event when a check changes state, so each one is
// a real transition. A REPEAT of the same state for the same check inside
// DEDUPE_WINDOW_MS is not re-sent, though: the webhook secret is the only thing
// standing between a caller and these channels (an authenticated caller could
// replay one Health payload at the route's rate limit). A CHANGE of state is
// always sent — failing → restored → failing again must end on "failing", or
// the admin's last word is "restored" while the check is down. The memory is
// per-process; a restart re-sends the next one.
import { emitNotificationEvent } from "./notify-agents";
import { processSingleton } from "./process-singleton";

const DEDUPE_WINDOW_MS = 10 * 60_000;
const MAX_TRACKED = 500;
const MAX_MESSAGE = 400;

// Per check: the last state forwarded and when.
const recent = processSingleton("arr-health-notify:recent", () => new Map<string, { eventType: string; at: number }>());

type HealthPayload = { level?: unknown; message?: unknown; type?: unknown };

const LEVELS = new Set(["notice", "warning", "error"]);

// Remote text (authenticated by the webhook secret, but not ours): control
// characters out, whitespace collapsed, bounded.
function clean(v: unknown, max: number): string {
  return typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "";
}

/**
 * "Radarr (4K) — error: Indexers unavailable due to failures". The default
 * instance carries no suffix. A restored check names no level: Radarr/Sonarr
 * send the PREVIOUS check's level with it, which would read "error" under a
 * "restored" headline.
 */
export function arrHealthText(
  service: "radarr" | "sonarr",
  instanceName: string | null,
  payload: HealthPayload,
  eventType: "Health" | "HealthRestored" = "Health",
): string | null {
  const message = clean(payload.message, MAX_MESSAGE);
  if (!message) return null;
  const label = service === "radarr" ? "Radarr" : "Sonarr";
  const name = clean(instanceName, 100);
  const level = eventType === "Health" && typeof payload.level === "string" && LEVELS.has(payload.level.toLowerCase())
    ? payload.level.toLowerCase()
    : null;
  return `${label}${name ? ` (${name})` : ""}${level ? ` — ${level}` : ""}: ${message}`;
}

/**
 * Forward one Health / HealthRestored delivery. Returns whether it was handed
 * to the channels (false: no message, or the same event inside the window).
 * `instanceName` is the registry display name, null for the default instance.
 */
export function forwardArrHealthEvent(args: {
  service: "radarr" | "sonarr";
  instance: string;
  instanceName: string | null;
  eventType: "Health" | "HealthRestored";
  payload: unknown;
  now?: number;
}): boolean {
  const payload = (args.payload && typeof args.payload === "object" ? args.payload : {}) as HealthPayload;
  const text = arrHealthText(args.service, args.instanceName, payload, args.eventType);
  if (!text) return false;
  const now = args.now ?? Date.now();
  // The CHECK, not the event: Health and HealthRestored for one check share a
  // key, so a state change is seen as one.
  const key = `${args.service}\u0000${args.instance}\u0000${clean(payload.type, 200)}\u0000${clean(payload.message, MAX_MESSAGE)}`;
  const last = recent.get(key);
  if (last !== undefined && last.eventType === args.eventType && now - last.at < DEDUPE_WINDOW_MS) return false;
  if (!recent.has(key) && recent.size >= MAX_TRACKED) {
    for (const [k, v] of recent) if (now - v.at >= DEDUPE_WINDOW_MS) recent.delete(k);
    // Still full of live entries: drop the oldest rather than refuse to track.
    while (recent.size >= MAX_TRACKED) recent.delete(recent.keys().next().value as string);
  }
  recent.delete(key);
  recent.set(key, { eventType: args.eventType, at: now });
  emitNotificationEvent({
    event: args.eventType === "Health" ? "arr.health" : "arr.health_restored",
    text,
    request: { instance: args.instance },
  });
  return true;
}

/** Test seam: forget every remembered delivery. */
export function _resetArrHealthDedupeForTests(): void {
  recent.clear();
}
