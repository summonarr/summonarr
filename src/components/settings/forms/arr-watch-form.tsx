"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "@/components/icons";
import { SaveStatusMessage } from "./save-status";
import { withBasePath } from "@/lib/base-path";
import { fetchJson, jsonInit } from "@/lib/client/fetch-json";
import { createSettingsSaver, type SaveStatus, type SettingsPatchResult } from "./shared";
import { useLocale, useT } from "@/components/i18n/i18n-provider";

// The last monitor run's counts, as GET /api/admin/arr-watch answers them.
// `at` is the run's time in ms, formatted at render (only ever after mount:
// the read happens in an effect).
interface RunSummary { at: number; attention: number; lowDisks: number; failed24h: number }

const count = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null);

// The summary in the GET answer: null when the monitor hasn't run, "error"
// when the answer isn't one.
function readSummary(data: unknown): RunSummary | null | "error" {
  const s = data && typeof data === "object" ? (data as { summary?: unknown }).summary : undefined;
  if (s === null) return null;
  if (!s || typeof s !== "object") return "error";
  const r = s as Record<string, unknown>;
  const at = typeof r.at === "string" ? Date.parse(r.at) : Number.NaN;
  const attention = count(r.attention);
  const lowDisks = count(r.lowDisks);
  const failed24h = count(r.failed24h);
  if (!Number.isFinite(at) || attention === null || lowDisks === null || failed24h === null) return "error";
  return { at, attention, lowDisks, failed24h };
}

// The monitor's own route, in the settings saver's answer shape so the form
// gets the shared save state (an edit during a save keeps Save locked).
async function patchArrWatch(body: Record<string, unknown>): Promise<SettingsPatchResult> {
  const res = await fetchJson(withBasePath("/api/admin/arr-watch"), { init: jsonInit("PATCH", body) });
  const raw = res.ok ? res.data : res.body;
  const data = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return { ok: res.ok, status: res.status, data, error: res.ok ? "" : res.error };
}

// The Radarr/Sonarr monitor's one setting: the share of a disk that must stay
// free before it is reported low (src/lib/arr-watch.ts). Saved through its own
// admin route, which refuses anything but a whole number from 1 to 50. Above
// it, the last run's counts (read on mount from the same route) — what the
// monitor currently sees, the same numbers the Download Queue badge reads.
export function ArrWatchForm({ initialPercent }: { initialPercent: string }) {
  const t = useT();
  const locale = useLocale();
  // undefined: not read yet; null: the monitor hasn't run yet; "error": the
  // read failed (the setting below works without it).
  const [summary, setSummary] = useState<RunSummary | null | "error" | undefined>(undefined);
  const [percent, setPercent] = useState(initialPercent);
  // The field's latest value, so a save's answer never overwrites an edit
  // made while it was in flight.
  const latestPercent = useRef(initialPercent);
  // Only the "Saved" tick fades; a validation error stays until the next edit.
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [error, setError] = useState("");
  const [saver] = useState(() => createSettingsSaver({ setStatus, setMessage: setError, resetMs: 4000, patch: patchArrWatch }));
  useEffect(() => saver.cancel, [saver]);

  useEffect(() => {
    const ctrl = new AbortController();
    void (async () => {
      const res = await fetchJson(withBasePath("/api/admin/arr-watch"), { signal: ctrl.signal });
      if (!res.ok && res.kind === "aborted") return;
      setSummary(res.ok ? readSummary(res.data) : "error");
    })();
    return () => ctrl.abort();
  }, []);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    const sent = percent;
    const result = await saver.save({ diskLowPercent: sent }, () => t("settings.form.common.saveFailed"));
    const stored = (result.data.settings as { diskLowPercent?: unknown } | undefined)?.diskLowPercent;
    if (result.ok && typeof stored === "number" && latestPercent.current === sent) setPercent(String(stored));
  }

  const tone = (n: number) => (n > 0 ? "text-amber-400" : "text-zinc-400");

  return (
    <form onSubmit={handleSave} className="space-y-4">
      {summary === null && <p className="text-xs text-zinc-500">{t("settings.form.arrWatch.neverRun")}</p>}
      {summary === "error" && <p className="text-xs text-zinc-500">{t("settings.form.arrWatch.lastRunUnavailable")}</p>}
      {summary && summary !== "error" && (
        <div className="space-y-1 rounded-lg px-3 py-2.5 text-xs" style={{ border: "1px solid var(--ds-border)" }}>
          <p className="text-zinc-500">{t("settings.form.arrWatch.lastRun", { time: new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(summary.at) })}</p>
          <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0">
            <li className={tone(summary.attention)}>{t("settings.form.arrWatch.summaryAttention", { count: summary.attention })}</li>
            <li className={tone(summary.lowDisks)}>{t("settings.form.arrWatch.summaryLowDisks", { count: summary.lowDisks })}</li>
            <li className={tone(summary.failed24h)}>{t("settings.form.arrWatch.summaryFailed", { count: summary.failed24h })}</li>
          </ul>
        </div>
      )}
      <div className="space-y-1.5">
        <Label htmlFor="arr-watch-disk-low-percent">{t("settings.form.arrWatch.diskLowLabel")}</Label>
        <Input
          id="arr-watch-disk-low-percent"
          type="number"
          min="1"
          max="50"
          step="1"
          inputMode="numeric"
          value={percent}
          onChange={(e) => { setPercent(e.target.value); latestPercent.current = e.target.value; saver.edited(); }}
          placeholder="10"
          className="bg-zinc-800 border-zinc-700 max-w-48"
        />
        <p className="text-xs text-zinc-500">{t("settings.form.arrWatch.diskLowHelp")}</p>
      </div>
      <div className="flex items-center gap-3 flex-wrap">
        <Button type="submit" size="sm" disabled={status === "saving"}>
          {status === "saving" ? <Loader2 className="w-4 h-4 animate-spin" /> : t("settings.form.common.save")}
        </Button>
        <SaveStatusMessage status={status} errorLabel={error || undefined} />
      </div>
    </form>
  );
}
