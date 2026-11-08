"use client";

import { useEffect, useRef, useState } from "react";
import { CheckCircle, XCircle, Loader2 } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import { patchSettings } from "@/components/settings/forms/shared";
import {
  type FeatureCategory,
  type FeatureDefinition,
  type FeatureFlags,
} from "@/lib/features";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/components/i18n/i18n-provider";
import type { Translator } from "@/lib/i18n/translate";
import { FLUSH_DELAY_MS, flushOutcome, nextRetryDelay, settleBatch } from "@/lib/feature-toggle-queue";
import { timedFetch } from "@/lib/client/fetch-json";

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
// never overwrites it. A 429 from that limit is "not sent yet": the batch stays
// pending and is retried after a backoff (feature-toggle-queue.ts).

// Feature labels/descriptions live in the registry (src/lib/features.ts) in
// English; the catalogs carry a translation per flag under a slug of its key
// ("feature.behavior.watchGrades" -> "behavior_watchGrades"). A flag added to
// the registry without catalog entries falls back to the registry's English
// rather than rendering a raw key (tests/i18n-settings-features.test.mts pins
// that every current flag has both).
function featureText(t: Translator, feature: FeatureDefinition): { label: string; description: string } {
  const slug = feature.key.replace(/^feature\./, "").replaceAll(".", "_");
  const labelKey = `settings.featureLabel.${slug}`;
  const descKey = `settings.featureDesc.${slug}`;
  const label = t(labelKey);
  const description = t(descKey);
  return {
    label: label === labelKey ? feature.label : label,
    description: description === descKey ? feature.description : description,
  };
}

// Every shown switch's starting value: the stored flag, else the registry's
// default — the value the switch renders, so a flip and a revert start from
// what is on screen.
function seedFlags(initialFlags: FeatureFlags, groups: FeaturesFormProps["groups"]): FeatureFlags {
  const seeded: FeatureFlags = { ...initialFlags };
  for (const group of groups) {
    for (const feature of group.features) seeded[feature.key] ??= feature.defaultEnabled;
  }
  return seeded;
}

function bodyFor(batch: [string, boolean][]): Record<string, string> {
  const body: Record<string, string> = {};
  for (const [key, target] of batch) body[key] = target ? "true" : "false";
  return body;
}

export function FeaturesForm({ initialFlags, groups }: FeaturesFormProps) {
  const t = useT();
  const [seeded] = useState(() => seedFlags(initialFlags, groups));
  const [flags, setFlags] = useState<FeatureFlags>(seeded);
  const [statusByKey, setStatusByKey] = useState<Record<string, SaveStatus>>({});
  const [errorByKey, setErrorByKey] = useState<Record<string, string>>({});

  const savedState = useRef<FeatureFlags>({ ...seeded });
  const pendingTarget = useRef<Map<string, boolean>>(new Map());
  const inFlight = useRef(false);
  // Switches whose save request is on its way right now, and the value sent.
  // A switch stays in pendingTarget until its reply comes back, so without this
  // the unmount cleanup would send the same value a second time. Cleanup skips
  // a switch only if it's still set to the value already being sent.
  const inFlightKeys = useRef<Map<string, boolean>>(new Map());
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statusTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // The rate-limit backoff: the last delay used (null when not backing off),
  // and whether the retry timer is pending — while it is, a new flip waits for
  // it instead of firing straight into another 429.
  const retryDelay = useRef<number | null>(null);
  const backingOff = useRef(false);
  // Set by the unmount cleanup, which sends what is pending itself: a flush
  // still in flight then stops, and nothing is scheduled again.
  const unmounted = useRef(false);

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

  // A key toggled back to the value the server already holds needs no
  // request — settle it locally.
  function settleUnchanged() {
    for (const [key, target] of [...pendingTarget.current]) {
      if (target === savedState.current[key]) {
        pendingTarget.current.delete(key);
        setStatusByKey((prev) => ({ ...prev, [key]: "ok" }));
        scheduleStatusClear(key);
      }
    }
  }

  function markSaving(batch: [string, boolean][]) {
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
  }

  // One PATCH for the batch: the reply flushOutcome reads (null when none
  // came) and the text a failure shows.
  async function sendBatch(batch: [string, boolean][]) {
    for (const [key, target] of batch) inFlightKeys.current.set(key, target);
    const result = await patchSettings(bodyFor(batch));
    for (const [key] of batch) inFlightKeys.current.delete(key);
    if (result.status === 0) return { reply: null, message: t("settings.common.networkError") };
    return {
      reply: { status: result.status, ok: result.data.ok === true ? true : undefined },
      message: result.error || t("settings.common.saveFailedStatus", { status: result.status }),
    };
  }

  function applySettled(settled: ReturnType<typeof settleBatch>, message: string) {
    for (const { key, ok, revertTo } of settled) {
      if (!ok) setFlags((prev) => ({ ...prev, [key]: revertTo ?? seeded[key] ?? false }));
      setStatusByKey((prev) => ({ ...prev, [key]: ok ? "ok" : "error" }));
      setErrorByKey((prev) => {
        const next = { ...prev };
        if (ok) delete next[key];
        else next[key] = message;
        return next;
      });
      // A failure stays on screen (icon + message) until the next toggle
      // of this switch; only the success tick fades.
      if (ok) scheduleStatusClear(key);
    }
  }

  async function flush() {
    // Only one flush at a time. A flip made meanwhile waits in pendingTarget and
    // is picked up by the loop below, or by the reschedule in `finally`.
    if (inFlight.current || unmounted.current) return;
    inFlight.current = true;

    try {
      while (true) {
        settleUnchanged();
        const batch = [...pendingTarget.current];
        if (batch.length === 0) return;
        markSaving(batch);

        const { reply, message } = await sendBatch(batch);
        // The unmount cleanup already sent what was left.
        if (unmounted.current) return;

        const outcome = flushOutcome(reply);
        if (outcome === "rateLimited") {
          // Not sent yet: the switches keep the admin's choice and their
          // spinner, and the whole batch goes out again after the backoff.
          retryDelay.current = nextRetryDelay(retryDelay.current);
          scheduleRetry(retryDelay.current);
          return;
        }
        retryDelay.current = null;

        // Only switches still set to what we just sent are finished; one the
        // user flipped again meanwhile goes out in the next loop round instead
        // of letting this older reply overwrite it.
        applySettled(settleBatch({ saved: savedState.current, pending: pendingTarget.current }, batch, outcome), message);
      }
    } finally {
      inFlight.current = false;
      // A flip made right after the loop's last check, but before inFlight was
      // cleared, had its scheduled flush return early — so schedule one now.
      if (pendingTarget.current.size > 0) scheduleFlush();
    }
  }

  function scheduleFlush() {
    // While backing off after a 429, the retry timer sends everything pending.
    if (backingOff.current) return;
    if (unmounted.current) return;
    if (flushTimer.current) clearTimeout(flushTimer.current);
    flushTimer.current = setTimeout(() => {
      flushTimer.current = null;
      void flush();
    }, FLUSH_DELAY_MS);
  }

  function scheduleRetry(delayMs: number) {
    backingOff.current = true;
    if (flushTimer.current) clearTimeout(flushTimer.current);
    flushTimer.current = setTimeout(() => {
      flushTimer.current = null;
      backingOff.current = false;
      void flush();
    }, delayMs);
  }

  useEffect(() => {
    // Copy the ref objects themselves (not their .current values) so the
    // cleanup reads whatever is pending at the moment the page unmounts. This
    // is also what the exhaustive-deps lint rule asks for.
    const timers = statusTimers;
    const pendingRef = pendingTarget;
    const inFlightRef = inFlightKeys;
    return () => {
      unmounted.current = true;
      if (flushTimer.current) clearTimeout(flushTimer.current);
      for (const timer of timers.current.values()) clearTimeout(timer);
      // Skip a switch whose same value is already being sent — that request
      // still reaches the server after unmount. A switch flipped again since
      // then is NOT skipped, or its newest value would be lost.
      const pending = [...pendingRef.current].filter(([key, target]) => inFlightRef.current.get(key) !== target);
      // Handed to the request below (or to the one already in flight): a flush
      // resuming after its await must not send them again.
      pendingRef.current.clear();
      if (pending.length === 0) return;
      // Send flips still waiting on the delay, so leaving the page right after
      // a click doesn't lose them. `keepalive` lets the request finish after the
      // page is gone.
      void timedFetch(withBasePath("/api/settings"), {
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
      : (savedState.current[key] ?? seeded[key] ?? false);
    const next = !current;

    pendingTarget.current.set(key, next);
    setFlags((prev) => ({ ...prev, [key]: next }));
    scheduleFlush();
  }

  return (
    <div className="space-y-4">
      {groups.map((group) => (
        // The same card recipe as every other settings tab (SettingsCard in
        // settings/page.tsx): bg-2 surface, --ds-border, --ds-r-lg, 22px padding,
        // 15px title, 12px muted description. Copied inline because that helper
        // is a server component and this file is "use client".
        <div
          key={group.category}
          style={{ padding: 22, background: "var(--ds-bg-2)", border: "1px solid var(--ds-border)", borderRadius: "var(--ds-r-lg)" }}
        >
          <div className="mb-5">
            <h2 className="font-semibold" style={{ fontSize: 15, letterSpacing: "-0.01em", color: "var(--ds-fg)", margin: 0 }}>
              {group.title}
            </h2>
            <p style={{ fontSize: 12, color: "var(--ds-fg-muted)", margin: "4px 0 0", lineHeight: 1.5 }}>{group.description}</p>
          </div>
          <div className="divide-y divide-zinc-800">
            {group.features.map((feature, idx) => {
              const enabled = flags[feature.key] ?? feature.defaultEnabled;
              const status = statusByKey[feature.key] ?? "idle";
              const text = featureText(t, feature);
              return (
                <div
                  key={feature.key}
                  className={`flex items-start justify-between gap-4 ${idx === 0 ? "pb-3" : "py-3"}`}
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-zinc-200">{text.label}</p>
                    <p className="text-xs text-zinc-500 mt-0.5">{text.description}</p>
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
                        aria-label={errorByKey[feature.key] ?? t("settings.common.saveFailed")}
                      />
                    )}
                    <Switch
                      checked={enabled}
                      aria-label={t("settings.features.toggle", { label: text.label })}
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
