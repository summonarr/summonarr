"use client";

import { useState } from "react";
import { CheckCircle, XCircle, Loader2 } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import { RATING_SOURCES } from "@/lib/ratings-visibility";
import type { SaveStatus } from "./shared";

export function RatingsVisibilityForm({ initialHidden }: { initialHidden: string[] }) {
  const [hidden, setHidden] = useState<string[]>(initialHidden);
  const [status, setStatus] = useState<SaveStatus>("idle");

  async function toggleSource(key: string) {
    const prev = hidden;
    const next = prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key];
    setHidden(next);
    setStatus("saving");
    try {
      const res = await fetch(withBasePath("/api/settings"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ratingsHiddenSources: JSON.stringify(next) }),
      });
      const data: { ok: boolean } = await res.json().catch(() => ({ ok: false }));
      if (!data.ok) {
        setHidden(prev);
        setStatus("error");
      } else {
        setStatus("ok");
      }
    } catch {
      setHidden(prev);
      setStatus("error");
    }
    setTimeout(() => setStatus("idle"), 3000);
  }

  return (
    <div>
      <div className="flex items-center gap-2 mb-0.5">
        <p className="text-sm font-medium text-zinc-200">Visible rating badges</p>
        {status === "saving" && <Loader2 className="w-3.5 h-3.5 animate-spin text-zinc-500" />}
        {status === "ok"     && <CheckCircle className="w-3.5 h-3.5 text-green-400" />}
        {status === "error"  && <XCircle className="w-3.5 h-3.5 text-red-400" />}
      </div>
      <p className="text-xs text-zinc-500 mb-3">
        Untick a source to hide its badge everywhere ratings render (detail pages, cards, the
        admin request list). Hiding a badge doesn&apos;t stop the data being fetched.
      </p>
      <div className="flex flex-wrap gap-x-5 gap-y-2">
        {RATING_SOURCES.map((s) => (
          <label key={s.key} className="flex items-center gap-1.5 text-xs text-zinc-300 cursor-pointer">
            <input
              type="checkbox"
              checked={!hidden.includes(s.key)}
              onChange={() => toggleSource(s.key)}
              className="w-3.5 h-3.5 accent-indigo-600"
            />
            {s.label}
          </label>
        ))}
      </div>
    </div>
  );
}
