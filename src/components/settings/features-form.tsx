"use client";

import { useRef, useState } from "react";
import { CheckCircle, XCircle, Loader2 } from "lucide-react";
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

// Trailing-edge coalescing pattern for rapid toggling.
//
// Why: a naïve optimistic-update + rollback approach races when a user
// double-clicks. Two overlapping PATCHes can land out of order, and a
// failure on the first rolls back state the user has already re-flipped.
//
// How: per key we track three pieces of ref-state:
//   - savedState    — last value the server acknowledged
//   - pendingTarget — user's latest intent, only present when it differs
//                     from savedState and hasn't been acked yet
//   - inFlight      — set of keys whose sync loop is currently running
//
// toggle() only updates local UI + pendingTarget and fires sync(). sync()
// is idempotent: if already running for this key, the existing loop will
// re-read pendingTarget after the in-flight PATCH resolves and fire a
// follow-up request only if the intent still differs from saved.
export function FeaturesForm({ initialFlags, groups }: FeaturesFormProps) {
  const [flags, setFlags] = useState<FeatureFlags>(initialFlags);
  const [statusByKey, setStatusByKey] = useState<Record<string, SaveStatus>>({});

  const savedState = useRef<FeatureFlags>({ ...initialFlags });
  const pendingTarget = useRef<Map<string, boolean>>(new Map());
  const inFlight = useRef<Set<string>>(new Set());
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

  async function sync(key: string) {
    if (inFlight.current.has(key)) return;
    inFlight.current.add(key);

    // Cancel any pending status clear — a new sync cycle is starting
    const existingTimer = statusTimers.current.get(key);
    if (existingTimer) {
      clearTimeout(existingTimer);
      statusTimers.current.delete(key);
    }

    try {
      // Loop until pendingTarget has caught up to savedState (or we give up).
      // The user can click again at any time; we'll see the new pendingTarget
      // on the next iteration.
      while (true) {
        const target = pendingTarget.current.get(key);
        if (target === undefined) return;
        if (target === savedState.current[key]) {
          // Already where the user wants it — nothing to send
          pendingTarget.current.delete(key);
          setStatusByKey((prev) => ({ ...prev, [key]: "ok" }));
          return;
        }

        setStatusByKey((prev) => ({ ...prev, [key]: "saving" }));

        let success = false;
        try {
          const res = await fetch("/api/settings", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ [key]: target ? "true" : "false" }),
          });
          const data: { ok: boolean; error?: string } = await res.json().catch(() => ({ ok: false }));
          success = res.ok && data.ok;
        } catch {
          success = false;
        }

        if (success) {
          savedState.current[key] = target;
          if (pendingTarget.current.get(key) === target) {
            pendingTarget.current.delete(key);
            setStatusByKey((prev) => ({ ...prev, [key]: "ok" }));
            return;
          }
          // User changed their mind mid-flight — loop with the new target
          continue;
        }

        // Failure path — only roll back if the user's intent still matches
        // what we just tried. If they've since clicked again, honor the new
        // target on the next iteration.
        if (pendingTarget.current.get(key) === target) {
          setFlags((prev) => ({ ...prev, [key]: savedState.current[key] ?? false }));
          pendingTarget.current.delete(key);
          setStatusByKey((prev) => ({ ...prev, [key]: "error" }));
          return;
        }
        // else: loop and try the new target
      }
    } finally {
      inFlight.current.delete(key);
      scheduleStatusClear(key);
    }
  }

  function toggle(key: string) {
    // Next value is derived from the latest intent, not from React state —
    // state may still be catching up to a rapid sequence of clicks.
    const current = pendingTarget.current.has(key)
      ? (pendingTarget.current.get(key) as boolean)
      : (savedState.current[key] ?? false);
    const next = !current;

    pendingTarget.current.set(key, next);
    setFlags((prev) => ({ ...prev, [key]: next }));
    void sync(key);
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
                    {status === "error" && <XCircle className="w-3.5 h-3.5 text-red-400" />}
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
