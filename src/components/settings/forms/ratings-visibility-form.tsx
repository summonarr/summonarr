"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2 } from "@/components/icons";
import { SaveStatusMessage } from "./save-status";
import { RATING_SOURCES } from "@/lib/ratings-visibility";
import { patchSettings, useSettingsSave } from "./shared";
import { useT } from "@/components/i18n/i18n-provider";

// Ticks made within this window go out as one save.
const SAVE_DELAY_MS = 600;

export function RatingsVisibilityForm({ initialHidden }: { initialHidden: string[] }) {
  const t = useT();
  const [hidden, setHidden] = useState<string[]>(initialHidden);
  // `error` is the route's own reason, shown in place of the bare "Failed to
  // save". Only an "ok" fades; an error stays until the next tick.
  const { status, message: error, save, edited } = useSettingsSave();
  // The list on screen, the list the server last accepted, the pending
  // trailing save and whether one is in flight. Refs: the timer and the
  // unmount cleanup read them outside render.
  const latest = useRef(initialHidden);
  const stored = useRef(initialHidden);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saving = useRef(false);

  // Every tick saves the whole list into one setting (ratingsHiddenSources).
  // Ticks are coalesced into one trailing save: there are more sources than
  // the route allows settings saves per minute, so a save per tick ran an
  // admin unticking them all into the 429. Saves never overlap (two could
  // finish in the wrong order and store the older list); a tick made while
  // one is out goes in the next.
  async function flush() {
    if (saving.current) return;
    const sent = latest.current;
    if (sent === stored.current) return;
    saving.current = true;
    const result = await save({ ratingsHiddenSources: JSON.stringify(sent) });
    saving.current = false;
    if (result.ok) {
      stored.current = sent;
    } else if (latest.current === sent) {
      // Refused, and nothing ticked since: back to what the server holds.
      latest.current = stored.current;
      setHidden(stored.current);
      return;
    }
    if (latest.current !== sent) schedule();
  }

  function schedule() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      void flush();
    }, SAVE_DELAY_MS);
  }

  function toggleSource(key: string) {
    const prev = latest.current;
    const next = prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key];
    latest.current = next;
    setHidden(next);
    edited();
    schedule();
  }

  useEffect(() => {
    const timerRef = timer;
    const latestRef = latest;
    return () => {
      // Leaving inside the delay: send the ticks still waiting.
      if (!timerRef.current) return;
      clearTimeout(timerRef.current);
      timerRef.current = null;
      void patchSettings({ ratingsHiddenSources: JSON.stringify(latestRef.current) });
    };
  }, []);

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
              className="w-4 h-4 accent-indigo-600"
            />
            {s.label}
          </label>
        ))}
      </div>
    </div>
  );
}
