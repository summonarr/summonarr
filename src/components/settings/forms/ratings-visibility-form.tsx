"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2 } from "@/components/icons";
import { SaveStatusMessage } from "./save-status";
import { withBasePath } from "@/lib/base-path";
import { RATING_SOURCES } from "@/lib/ratings-visibility";
import type { SaveStatus } from "./shared";
import { useT } from "@/components/i18n/i18n-provider";

export function RatingsVisibilityForm({ initialHidden }: { initialHidden: string[] }) {
  const t = useT();
  const [hidden, setHidden] = useState<string[]>(initialHidden);
  const [status, setStatus] = useState<SaveStatus>("idle");
  // The route's own reason — shown in place of the bare "Failed to save".
  const [error, setError] = useState<string | null>(null);
  // The timer that fades "Saved" back to idle. A new save cancels the old
  // timer; otherwise it could fire mid-save, set "idle", and unlock the control
  // while the request is still in flight. Only an "ok" fades — an error stays
  // until the next tick so the reason can be read.
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (idleTimer.current) clearTimeout(idleTimer.current);
  }, []);

  // Only one save at a time: the checkboxes are disabled while a save runs.
  // Every checkbox saves the whole list into one setting (ratingsHiddenSources),
  // and that setting skips the route's per-key cooldown (so a second tick within
  // 10s isn't rejected with a 429). Without the lock, two overlapping saves could
  // finish in the wrong order and store the older list.
  async function toggleSource(key: string) {
    const prev = hidden;
    const next = prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key];
    setHidden(next);
    if (idleTimer.current) clearTimeout(idleTimer.current);
    setStatus("saving");
    setError(null);
    try {
      const res = await fetch(withBasePath("/api/settings"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ratingsHiddenSources: JSON.stringify(next) }),
      });
      const data: { ok?: boolean; error?: string } = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        setHidden(prev);
        setError(data.error ?? t("settings.form.common.saveFailed"));
        setStatus("error");
      } else {
        setStatus("ok");
      }
    } catch {
      setHidden(prev);
      setError(t("settings.form.common.saveFailed"));
      setStatus("error");
    }
    idleTimer.current = setTimeout(() => setStatus((s) => (s === "ok" ? "idle" : s)), 3000);
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mb-0.5">
        <p className="text-sm font-medium text-zinc-200">{t("settings.form.ratingsVisibility.title")}</p>
        {status === "saving" && <Loader2 className="w-3.5 h-3.5 animate-spin text-zinc-500" aria-hidden />}
        <SaveStatusMessage status={status} errorLabel={error ?? t("settings.form.common.saveFailed")} />
      </div>
      <p className="text-xs text-zinc-500 mb-3">
        {t("settings.form.ratingsVisibility.help")}
      </p>
      <div className="flex flex-wrap gap-x-5 gap-y-1">
        {RATING_SOURCES.map((s) => (
          <label key={s.key} className="flex items-center gap-2 py-1 text-xs text-zinc-300 cursor-pointer">
            <input
              type="checkbox"
              checked={!hidden.includes(s.key)}
              onChange={() => toggleSource(s.key)}
              disabled={status === "saving"}
              className="w-4 h-4 accent-indigo-600"
            />
            {s.label}
          </label>
        ))}
      </div>
    </div>
  );
}
