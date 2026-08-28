"use client";

import { useEffect, useRef, useState } from "react";
import { CheckCircle, XCircle, Loader2 } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import {
  type FeatureCategory,
  type FeatureDefinition,
  type FeatureFlags,
} from "@/lib/features";

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

// Trailing-edge coalescing pattern for rapid toggling, batched ACROSS keys.
//
// Why: a naïve optimistic-update + rollback approach races when a user
// double-clicks. Two overlapping PATCHes can land out of order, and a
// failure on the first rolls back state the user has already re-flipped.
//
// Why batched: /api/settings is rate limited to 10 PATCHes per minute per
// admin, shared across every settings form. One request per flip meant an
// admin working through the ~24 flags here started getting 429s partway,
// with only a small red icon to explain it. The route accepts an arbitrary
// map of allowed keys, so every pending flip goes out in ONE request —
// matching how the multi-field settings forms (e.g. RateLimitForm) save.
//
// How: per key we track the user's latest intent; a short debounce lets a
// burst of flips collect into a single body.
//   - savedState    — last value the server acknowledged
//   - pendingTarget — user's latest intent, only present when it differs
//                     from savedState and hasn't been acked yet
//   - inFlight      — whether a flush is currently running (one at a time)
//
// toggle() only updates local UI + pendingTarget and schedules a flush.
// flush() loops: after each batch settles it re-reads pendingTarget, so a
// key re-flipped mid-request is picked up by the next batch rather than
// being clobbered by a stale response.
const FLUSH_DELAY_MS = 400;

export function FeaturesForm({ initialFlags, groups }: FeaturesFormProps) {
  const [flags, setFlags] = useState<FeatureFlags>(initialFlags);
  const [statusByKey, setStatusByKey] = useState<Record<string, SaveStatus>>({});
  const [errorByKey, setErrorByKey] = useState<Record<string, string>>({});

  const savedState = useRef<FeatureFlags>({ ...initialFlags });
  const pendingTarget = useRef<Map<string, boolean>>(new Map());
  const inFlight = useRef(false);
  // Keys whose PATCH is currently on the wire. A key stays in pendingTarget
  // until its response settles (so a mid-flight re-flip is re-sent), which means
  // the unmount cleanup would otherwise re-PATCH a value already in flight —
  // racing the two writes for the same key. Cleanup skips anything listed here.
  const inFlightKeys = useRef<Set<string>>(new Set());
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statusTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  function scheduleStatusClear(key: string) {
    const existing = statusTimers.current.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      statusTimers.current.delete(key);
      setStatusByKey((prev) => {
        // Don't clear if another sync is already running for this key
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
    // One flush at a time. A toggle arriving mid-flush lands in pendingTarget
    // and is picked up by the loop below, or by the reschedule in `finally`.
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
        for (const [key] of batch) inFlightKeys.current.add(key);
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
          // Only settle a key whose intent is still what we just sent. If the
          // user re-flipped it mid-request, the next loop iteration sends the
          // newer value rather than a stale response overwriting it.
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
          scheduleStatusClear(key);
        }
      }
    } finally {
      inFlight.current = false;
      // Closes the race where a toggle arrives after the final loop check but
      // before the flag clears: that scheduled flush would have returned early.
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
    // Capture the ref objects, not their contents: cleanup must read whatever
    // is pending AT UNMOUNT, so dereferencing .current inside the closure is
    // the point. Aliasing the containers (not the values) is what the
    // exhaustive-deps rule actually asks for here.
    const timers = statusTimers;
    const pendingRef = pendingTarget;
    const inFlightRef = inFlightKeys;
    return () => {
      if (flushTimer.current) clearTimeout(flushTimer.current);
      for (const timer of timers.current.values()) clearTimeout(timer);
      // Exclude keys whose PATCH is already on the wire — re-sending them would
      // race a duplicate write for the same key (and the in-flight request will
      // reach the server regardless of unmount).
      const pending = [...pendingRef.current].filter(([key]) => !inFlightRef.current.has(key));
      if (pending.length === 0) return;
      // Each toggle used to PATCH immediately, so navigating away right after a
      // click still saved it. The debounce would drop that; `keepalive` lets the
      // request outlive the unmount so batching does not cost a lost flip.
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
    // Next value is derived from the latest intent, not from React state —
    // state may still be catching up to a rapid sequence of clicks.
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
            <h2 className="font-semibold text-white text-lg">{group.title}</h2>
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
                      <p className="text-xs text-amber-500/80 mt-1">{feature.note}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0 pt-0.5">
                    {status === "saving" && <Loader2 className="w-3.5 h-3.5 animate-spin text-zinc-500" />}
                    {status === "ok" && <CheckCircle className="w-3.5 h-3.5 text-green-400" />}
                    {status === "error" && (
                      <XCircle
                        className="w-3.5 h-3.5 text-red-400"
                        aria-label={errorByKey[feature.key] ?? "Save failed"}
                      />
                    )}
                    <button
                      type="button"
                      role="switch"
                      aria-checked={enabled}
                      aria-label={`Toggle ${feature.label}`}
                      onClick={() => toggle(feature.key)}
                      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 focus:ring-offset-zinc-900 ${
                        enabled ? "bg-indigo-600" : "bg-zinc-700"
                      }`}
                    >
                      <span
                        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                          enabled ? "translate-x-4" : "translate-x-0.5"
                        }`}
                      />
                    </button>
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
