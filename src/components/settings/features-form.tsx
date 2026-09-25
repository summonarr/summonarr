"use client";

import { useEffect, useRef, useState } from "react";
import { CheckCircle, XCircle, Loader2 } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import {
  type FeatureCategory,
  type FeatureDefinition,
  type FeatureFlags,
} from "@/lib/features";
import { Switch } from "@/components/ui/switch";

type SaveStatus = "idle" | "saving" | "ok" | "error";

interface FeaturesFormProps {
  initialFlags: FeatureFlags;
  groups: {
    category: FeatureCategory;
    title: string;
    description: string;
    features: FeatureDefinition[];
  }[];
}

// How switch flips are saved: wait briefly, then send every pending flip (for
// any number of switches) in one request.
//
// Why not save each flip straight away: two quick requests for the same switch
// can arrive out of order, and undoing a failed first one could undo a newer
// flip the user already made.
//
// Why one request for all switches: /api/settings allows only 10 saves per
// minute per admin (shared by every settings form), so an admin flipping many
// of the ~24 switches here would hit "too many requests" errors. The route
// takes many keys at once, like the other multi-field settings forms do.
//
// What we track, per switch:
//   - savedState    — the last value the server confirmed
//   - pendingTarget — the value the user wants, if not yet confirmed
//   - inFlight      — whether a save is running right now (only one at a time)
//
// toggle() just updates the screen + pendingTarget and schedules a save.
// flush() keeps going until nothing is pending, so a switch flipped again
// while a save was running gets sent in the next round, and an older reply
// never overwrites it.
const FLUSH_DELAY_MS = 400;

export function FeaturesForm({ initialFlags, groups }: FeaturesFormProps) {
  const [flags, setFlags] = useState<FeatureFlags>(initialFlags);
  const [statusByKey, setStatusByKey] = useState<Record<string, SaveStatus>>({});
  const [errorByKey, setErrorByKey] = useState<Record<string, string>>({});

  const savedState = useRef<FeatureFlags>({ ...initialFlags });
  const pendingTarget = useRef<Map<string, boolean>>(new Map());
  const inFlight = useRef(false);
  // Switches whose save request is on its way right now, and the value sent.
  // A switch stays in pendingTarget until its reply comes back, so without this
  // the unmount cleanup would send the same value a second time. Cleanup skips
  // a switch only if it's still set to the value already being sent.
  const inFlightKeys = useRef<Map<string, boolean>>(new Map());
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statusTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  function scheduleStatusClear(key: string) {
    const existing = statusTimers.current.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      statusTimers.current.delete(key);
      setStatusByKey((prev) => {
        // Don't clear it if a new save for this switch is already running.
        if (prev[key] === "saving") return prev;
        const copy = { ...prev };
        delete copy[key];
        return copy;
      });
    }, 2500);
    statusTimers.current.set(key, timer);
  }

  function bodyFor(batch: [string, boolean][]): Record<string, string> {
    const body: Record<string, string> = {};
    for (const [key, target] of batch) body[key] = target ? "true" : "false";
    return body;
  }

  async function flush() {
    // Only one flush at a time. A flip made meanwhile waits in pendingTarget and
    // is picked up by the loop below, or by the reschedule in `finally`.
    if (inFlight.current) return;
    inFlight.current = true;

    try {
      while (true) {
        // A key toggled back to the value the server already holds needs no
        // request — settle it locally.
        for (const [key, target] of [...pendingTarget.current]) {
          if (target === savedState.current[key]) {
            pendingTarget.current.delete(key);
            setStatusByKey((prev) => ({ ...prev, [key]: "ok" }));
            scheduleStatusClear(key);
          }
        }

        const batch = [...pendingTarget.current];
        if (batch.length === 0) return;

        for (const [key] of batch) {
          const existing = statusTimers.current.get(key);
          if (existing) {
            clearTimeout(existing);
            statusTimers.current.delete(key);
          }
        }
        setStatusByKey((prev) => {
          const next = { ...prev };
          for (const [key] of batch) next[key] = "saving";
          return next;
        });

        let success = false;
        let message = "";
        for (const [key, target] of batch) inFlightKeys.current.set(key, target);
        try {
          const res = await fetch(withBasePath("/api/settings"), {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(bodyFor(batch)),
          });
          const data: { ok?: boolean; error?: string } = await res.json().catch(() => ({}));
          success = res.ok && data.ok === true;
          if (!success) message = data.error ?? `Save failed (${res.status})`;
        } catch {
          success = false;
          message = "Network error — the change was not saved";
        } finally {
          for (const [key] of batch) inFlightKeys.current.delete(key);
        }

        for (const [key, target] of batch) {
          if (success) savedState.current[key] = target;
          // Only finish off a switch that's still set to what we just sent. If
          // the user flipped it again meanwhile, the next loop round sends the
          // newer value instead of letting this older reply overwrite it.
          if (pendingTarget.current.get(key) !== target) continue;
          pendingTarget.current.delete(key);
          if (!success) setFlags((prev) => ({ ...prev, [key]: savedState.current[key] ?? false }));
          setStatusByKey((prev) => ({ ...prev, [key]: success ? "ok" : "error" }));
          setErrorByKey((prev) => {
            const next = { ...prev };
            if (success) delete next[key];
            else next[key] = message;
            return next;
          });
          // A failure stays on screen (icon + message) until the next toggle
          // of this switch; only the success tick fades.
          if (success) scheduleStatusClear(key);
        }
      }
    } finally {
      inFlight.current = false;
      // A flip made right after the loop's last check, but before inFlight was
      // cleared, had its scheduled flush return early — so schedule one now.
      if (pendingTarget.current.size > 0) scheduleFlush();
    }
  }

  function scheduleFlush() {
    if (flushTimer.current) clearTimeout(flushTimer.current);
    flushTimer.current = setTimeout(() => {
      flushTimer.current = null;
      void flush();
    }, FLUSH_DELAY_MS);
  }

  useEffect(() => {
    // Copy the ref objects themselves (not their .current values) so the
    // cleanup reads whatever is pending at the moment the page unmounts. This
    // is also what the exhaustive-deps lint rule asks for.
    const timers = statusTimers;
    const pendingRef = pendingTarget;
    const inFlightRef = inFlightKeys;
    return () => {
      if (flushTimer.current) clearTimeout(flushTimer.current);
      for (const timer of timers.current.values()) clearTimeout(timer);
      // Skip a switch whose same value is already being sent — that request
      // still reaches the server after unmount. A switch flipped again since
      // then is NOT skipped, or its newest value would be lost.
      const pending = [...pendingRef.current].filter(([key, target]) => inFlightRef.current.get(key) !== target);
      if (pending.length === 0) return;
      // Send flips still waiting on the delay, so leaving the page right after
      // a click doesn't lose them. `keepalive` lets the request finish after the
      // page is gone.
      void fetch(withBasePath("/api/settings"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bodyFor(pending)),
        keepalive: true,
      }).catch(() => {});
    };
    // Runs once: the refs it reads are stable and always hold the latest intent.
  }, []);

  function toggle(key: string) {
    // Work out the new value from the latest intent, not from React state,
    // which may not have caught up yet after several fast clicks.
    const current = pendingTarget.current.has(key)
      ? (pendingTarget.current.get(key) as boolean)
      : (savedState.current[key] ?? false);
    const next = !current;

    pendingTarget.current.set(key, next);
    setFlags((prev) => ({ ...prev, [key]: next }));
    scheduleFlush();
  }

  return (
    <div className="space-y-4">
      {groups.map((group) => (
        <div key={group.category} className="bg-zinc-900 border border-zinc-800 rounded-lg p-6">
          <div className="mb-5">
            <h2 className="font-semibold text-zinc-100 text-lg">{group.title}</h2>
            <p className="text-sm text-zinc-500 mt-0.5">{group.description}</p>
          </div>
          <div className="divide-y divide-zinc-800">
            {group.features.map((feature, idx) => {
              const enabled = flags[feature.key] ?? feature.defaultEnabled;
              const status = statusByKey[feature.key] ?? "idle";
              return (
                <div
                  key={feature.key}
                  className={`flex items-start justify-between gap-4 ${idx === 0 ? "pb-3" : "py-3"}`}
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-zinc-200">{feature.label}</p>
                    <p className="text-xs text-zinc-500 mt-0.5">{feature.description}</p>
                    {feature.note && (
                      <p className="text-xs text-amber-400 mt-1">{feature.note}</p>
                    )}
                    {status === "error" && errorByKey[feature.key] && (
                      <p role="alert" className="text-xs text-red-400 mt-1">{errorByKey[feature.key]}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0 pt-0.5">
                    {status === "saving" && <Loader2 className="w-3.5 h-3.5 animate-spin text-zinc-500" />}
                    {status === "ok" && <CheckCircle className="w-3.5 h-3.5 text-green-400" />}
                    {status === "error" && (
                      <XCircle
                        role="img"
                        className="w-3.5 h-3.5 text-red-400"
                        aria-label={errorByKey[feature.key] ?? "Save failed"}
                      />
                    )}
                    <Switch
                      checked={enabled}
                      aria-label={`Toggle ${feature.label}`}
                      onCheckedChange={() => toggle(feature.key)}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
