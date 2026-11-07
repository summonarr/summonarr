"use client";

import { useState } from "react";
import { Loader2 } from "@/components/icons";
import { SaveStatusMessage } from "./save-status";
import { RATING_SOURCES } from "@/lib/ratings-visibility";
import { useSettingsSave } from "./shared";
import { useT } from "@/components/i18n/i18n-provider";

export function RatingsVisibilityForm({ initialHidden }: { initialHidden: string[] }) {
  const t = useT();
  const [hidden, setHidden] = useState<string[]>(initialHidden);
  // `error` is the route's own reason, shown in place of the bare "Failed to
  // save". Only an "ok" fades; an error stays until the next tick.
  const { status, message: error, save } = useSettingsSave();

  // Only one save at a time: the checkboxes are disabled while a save runs.
  // Every checkbox saves the whole list into one setting (ratingsHiddenSources),
  // and that setting skips the route's per-key cooldown (so a second tick within
  // 10s isn't rejected with a 429). Without the lock, two overlapping saves could
  // finish in the wrong order and store the older list.
  async function toggleSource(key: string) {
    const prev = hidden;
    const next = prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key];
    setHidden(next);
    const result = await save({ ratingsHiddenSources: JSON.stringify(next) });
    if (!result.ok) setHidden(prev);
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mb-0.5">
        <p className="text-sm font-medium text-zinc-200">{t("settings.form.ratingsVisibility.title")}</p>
        {status === "saving" && <Loader2 className="w-3.5 h-3.5 animate-spin text-zinc-500" aria-hidden />}
        <SaveStatusMessage status={status} errorLabel={error || t("settings.form.common.saveFailed")} />
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
