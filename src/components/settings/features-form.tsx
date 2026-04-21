"use client";

import { useState } from "react";
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

export function FeaturesForm({ initialFlags, groups }: FeaturesFormProps) {
  const [flags, setFlags] = useState<FeatureFlags>(initialFlags);
  const [statusByKey, setStatusByKey] = useState<Record<string, SaveStatus>>({});

  async function toggle(key: string) {
    const next = !flags[key];
    setFlags((prev) => ({ ...prev, [key]: next }));
    setStatusByKey((prev) => ({ ...prev, [key]: "saving" }));

    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: next ? "true" : "false" }),
      });
      const data: { ok: boolean; error?: string } = await res.json();
      if (!res.ok || !data.ok) {
        // Roll back on server-side rejection
        setFlags((prev) => ({ ...prev, [key]: !next }));
        setStatusByKey((prev) => ({ ...prev, [key]: "error" }));
      } else {
        setStatusByKey((prev) => ({ ...prev, [key]: "ok" }));
      }
    } catch {
      setFlags((prev) => ({ ...prev, [key]: !next }));
      setStatusByKey((prev) => ({ ...prev, [key]: "error" }));
    }

    setTimeout(() => {
      setStatusByKey((prev) => {
        if (prev[key] === "saving") return prev;
        const copy = { ...prev };
        delete copy[key];
        return copy;
      });
    }, 2500);
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
