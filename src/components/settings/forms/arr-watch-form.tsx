"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "@/components/icons";
import { SaveStatusMessage } from "./save-status";
import { withBasePath } from "@/lib/base-path";
import type { SaveStatus } from "./shared";
import { useLocale, useT } from "@/components/i18n/i18n-provider";

// The last monitor run's counts, as GET /api/admin/arr-watch answers them.
interface RunSummary { atLabel: string; attention: number; lowDisks: number; failed24h: number }

const count = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null);

// The Radarr/Sonarr monitor's one setting: the share of a disk that must stay
// free before it is reported low (src/lib/arr-watch.ts). Saved through its own
// admin route, which refuses anything but a whole number from 1 to 50. Above
// it, the last run's counts (read on mount from the same route) — what the
// monitor currently sees, the same numbers the Download Queue badge reads.
export function ArrWatchForm({ initialPercent }: { initialPercent: string }) {
  const t = useT();
  const locale = useLocale();
  // undefined: not read (or unreadable — nothing shown); null: the monitor hasn't run yet.
  const [summary, setSummary] = useState<RunSummary | null | undefined>(undefined);
  const [percent, setPercent] = useState(initialPercent);
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [error, setError] = useState("");
  // Only the "Saved" tick fades; a validation error stays until the next edit.
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (resetTimer.current) clearTimeout(resetTimer.current); }, []);

  // Read after mount; the time is formatted here, never during render (guardrail 16).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(withBasePath("/api/admin/arr-watch"));
        if (!res.ok) return;
        const data = (await res.json()) as { summary?: Record<string, unknown> | null };
        if (cancelled) return;
        const s = data.summary;
        if (s === null) {
          setSummary(null);
          return;
        }
        const at = typeof s?.at === "string" ? Date.parse(s.at) : Number.NaN;
        const attention = count(s?.attention);
        const lowDisks = count(s?.lowDisks);
        const failed24h = count(s?.failed24h);
        if (!Number.isFinite(at) || attention === null || lowDisks === null || failed24h === null) return;
        const atLabel = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(at);
        setSummary({ atLabel, attention, lowDisks, failed24h });
      } catch {
        // The counts are a convenience; the setting below works without them.
      }
    })();
    return () => { cancelled = true; };
  }, [locale]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (resetTimer.current) clearTimeout(resetTimer.current);
    setStatus("saving");
    setError("");
    try {
      const res = await fetch(withBasePath("/api/admin/arr-watch"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ diskLowPercent: percent }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; settings?: { diskLowPercent?: number } };
      if (res.ok) {
        if (typeof data.settings?.diskLowPercent === "number") setPercent(String(data.settings.diskLowPercent));
        setStatus("ok");
        resetTimer.current = setTimeout(() => setStatus("idle"), 4000);
      } else {
        setError(data.error ?? t("settings.form.common.saveFailed"));
        setStatus("error");
      }
    } catch {
      setError(t("settings.form.common.saveFailed"));
      setStatus("error");
    }
  }

  const tone = (n: number) => (n > 0 ? "text-amber-400" : "text-zinc-400");

  return (
    <form onSubmit={handleSave} className="space-y-4">
      {summary === null && <p className="text-xs text-zinc-500">{t("settings.form.arrWatch.neverRun")}</p>}
      {summary && (
        <div className="space-y-1 rounded-lg px-3 py-2.5 text-xs" style={{ border: "1px solid var(--ds-border)" }}>
          <p className="text-zinc-500">{t("settings.form.arrWatch.lastRun", { time: summary.atLabel })}</p>
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
          onChange={(e) => { setPercent(e.target.value); setStatus("idle"); }}
          placeholder="10"
          className="bg-zinc-800 border-zinc-700 max-w-48"
        />
        <p className="text-xs text-zinc-500">{t("settings.form.arrWatch.diskLowHelp")}</p>
      </div>
      <div className="flex items-center gap-3 flex-wrap">
        <Button type="submit" size="sm" disabled={status === "saving"}>
          {status === "saving" ? <Loader2 className="w-4 h-4 animate-spin" /> : t("settings.form.common.save")}
        </Button>
        <SaveStatusMessage status={status} errorLabel={error} />
      </div>
    </form>
  );
}
