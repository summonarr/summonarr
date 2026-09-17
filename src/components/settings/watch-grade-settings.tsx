"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CheckCircle, XCircle, Loader2 } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import {
  WATCH_GRADE_DEFAULTS,
  WATCH_GRADE_SETTING_KEYS,
  type WatchGradePreview,
  type WatchGradeSpread,
} from "@/lib/watch-grade";

type SaveStatus = "idle" | "saving" | "ok" | "error";
type Field = keyof typeof WATCH_GRADE_SETTING_KEYS;

const SPREAD_COLUMNS: { key: keyof WatchGradeSpread; label: string }[] = [
  { key: "A", label: "A" },
  { key: "B", label: "B" },
  { key: "C", label: "C" },
  { key: "D", label: "D" },
  { key: "F", label: "F" },
  { key: "notGraded", label: "Not graded" },
];

const BAND_FIELDS: { field: "bandA" | "bandB" | "bandC" | "bandD"; letter: string }[] = [
  { field: "bandA", letter: "A" },
  { field: "bandB", letter: "B" },
  { field: "bandC", letter: "C" },
  { field: "bandD", letter: "D" },
];

// Tuning for request watch grades (src/lib/watch-grade.ts). A blank field saves
// as "use the default"; /api/settings enforces the same bounds and cross-field
// rules the grader parses with, and its error message is shown verbatim.
//
// Preview grades every requester with the values typed here and with the ones in
// force, and shows how many land on each letter — before anything is saved. It
// posts the same body a save would, so it judges exactly what Save would store.
export function WatchGradeSettingsForm({ initial }: { initial: Record<Field, string> }) {
  const [values, setValues] = useState<Record<Field, string>>(initial);
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ body: string; result: WatchGradePreview } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  function set(field: Field, value: string) {
    setValues((v) => ({ ...v, [field]: value }));
    setStatus("idle");
  }

  // The body both Save and Preview send: every watch-grade key, trimmed.
  function body(): string {
    const out: Record<string, string> = {};
    for (const field of Object.keys(WATCH_GRADE_SETTING_KEYS) as Field[]) {
      out[WATCH_GRADE_SETTING_KEYS[field]] = values[field].trim();
    }
    return JSON.stringify(out);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setStatus("saving");
    setError(null);
    try {
      const res = await fetch(withBasePath("/api/settings"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: body(),
      });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!res.ok || !data?.ok) {
        setError(data?.error ?? `Save failed (${res.status})`);
        setStatus("error");
        return;
      }
      setStatus("ok");
      // The preview's "Now" row described the settings just replaced.
      setPreview(null);
    } catch {
      setError("Network error — please try again");
      setStatus("error");
    }
    setTimeout(() => setStatus("idle"), 3000);
  }

  async function handlePreview() {
    const sent = body();
    setPreviewing(true);
    setPreviewError(null);
    try {
      const res = await fetch(withBasePath("/api/admin/watch-grade/preview"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: sent,
      });
      const data = (await res.json().catch(() => null)) as (WatchGradePreview & { error?: string }) | null;
      if (!res.ok || !data) {
        setPreviewError(data?.error ?? `Preview failed (${res.status})`);
        return;
      }
      setPreview({ body: sent, result: data });
    } catch {
      setPreviewError("Network error — please try again");
    } finally {
      setPreviewing(false);
    }
  }

  const stale = preview !== null && preview.body !== body();

  const numberField = (
    field: Field,
    id: string,
    label: string,
    bounds: { min: number; max: number },
    help: React.ReactNode,
  ) => (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        min={bounds.min}
        max={bounds.max}
        placeholder={String(WATCH_GRADE_DEFAULTS[field])}
        value={values[field]}
        onChange={(e) => set(field, e.target.value)}
        className="bg-zinc-800 border-zinc-700 text-sm w-32"
      />
      <p className="text-xs text-zinc-500">{help}</p>
    </div>
  );

  return (
    <form onSubmit={handleSave} className="space-y-5">
      {numberField("graceDays", "watch-grade-grace", "Grace period (days)", { min: 1, max: 365 }, (
        <>How long after a request becomes available before it counts toward the grade. Requests still inside it are listed but never scored — watched or not — so recent requesters aren&apos;t judged early. Default {WATCH_GRADE_DEFAULTS.graceDays}.</>
      ))}

      {numberField("windowDays", "watch-grade-window", "Grade window (days)", { min: 0, max: 3650 }, (
        <>Only requests fulfilled within this many days are graded, so a user&apos;s grade reflects recent habits. 30–3650, or 0 for no limit. Must be longer than the grace period. Default {WATCH_GRADE_DEFAULTS.windowDays}.</>
      ))}

      {numberField("tvEpisodePercent", "watch-grade-tv", "Episodes of a season needed (%)", { min: 1, max: 100 }, (
        <>Share of a season&apos;s regular-season episodes in the library that must be watched for full credit; fewer earns partial credit. Each season is scored on its own and the best one counts, so a finished season keeps its credit as later seasons arrive. Default {WATCH_GRADE_DEFAULTS.tvEpisodePercent}.</>
      ))}

      {numberField("otherViewers", "watch-grade-others", "Other viewers for credit", { min: 0, max: 100 }, (
        <>A request the requester didn&apos;t watch still counts as watched once this many other people have watched it since it was requested. Each counts as play history recorded them — a movie marked Watched, or a season&apos;s episodes to the share above — and someone with both a Plex and a Jellyfin login counts once. 1–100, or 0 to turn it off. Default {WATCH_GRADE_DEFAULTS.otherViewers}.</>
      ))}

      <fieldset className="space-y-1.5">
        <legend className="text-sm font-medium leading-none mb-1.5">Letter cutoffs (%)</legend>
        <div className="flex flex-wrap gap-3">
          {BAND_FIELDS.map(({ field, letter }) => (
            <div key={field} className="flex items-center gap-2">
              <Label htmlFor={`watch-grade-band-${letter}`} className="w-3">{letter}</Label>
              <Input
                id={`watch-grade-band-${letter}`}
                type="number"
                min={1}
                max={100}
                placeholder={String(WATCH_GRADE_DEFAULTS[field])}
                value={values[field]}
                onChange={(e) => set(field, e.target.value)}
                className="bg-zinc-800 border-zinc-700 text-sm w-20"
              />
            </div>
          ))}
        </div>
        <p className="text-xs text-zinc-500">
          The watch rate a user needs for each letter; anything below D is an F. Each cutoff must be higher than the next. Defaults A {WATCH_GRADE_DEFAULTS.bandA}, B {WATCH_GRADE_DEFAULTS.bandB}, C {WATCH_GRADE_DEFAULTS.bandC}, D {WATCH_GRADE_DEFAULTS.bandD}.
        </p>
      </fieldset>

      {numberField("minGradedRequests", "watch-grade-min-requests", "Requests needed for a letter", { min: 1, max: 100 }, (
        <>Scored requests a user needs before a letter shows. Below it their watch rate is still shown, just without a letter, so one unwatched film can&apos;t stamp a new requester an F. 1–100. Default {WATCH_GRADE_DEFAULTS.minGradedRequests}.</>
      ))}

      <div className="space-y-2 pt-2 border-t border-zinc-800">
        <h3 className="text-sm font-medium text-zinc-300 pt-2">How grades work</h3>
        <p className="text-xs text-zinc-500">
          Each user is graded A–F on the share of their fulfilled requests they went on to watch, by the cutoffs above, once enough requests count. A movie counts when it reaches the play history Watched threshold (half credit once a quarter of it is played), a show when the share of one season&apos;s episodes is watched, and any request counts once enough other people have watched it. The same title requested on two instances counts once. Only plays after the request count, and requests fulfilled before play history began recording aren&apos;t graded. Grades are shown to admins only and never block a request.
        </p>
      </div>

      <div className="space-y-2 pt-2 border-t border-zinc-800">
        <div className="flex items-center gap-3 pt-2">
          <h3 className="text-sm font-medium text-zinc-300">Preview</h3>
          <Button type="button" variant="outline" size="sm" onClick={handlePreview} disabled={previewing}>
            {previewing ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : null}
            {preview ? "Preview again" : "Preview these values"}
          </Button>
        </div>
        <p className="text-xs text-zinc-500">
          Grades every requester with the values above and with the ones saved now, without saving anything.
        </p>
        {previewError && <p className="text-xs text-red-400">{previewError}</p>}
        {preview && !preview.result.enabled && (
          <p className="text-xs text-zinc-400">
            {preview.result.reason === "feature-off"
              ? "Watch grades are turned off in Settings → Features, so there is nothing to preview."
              : "Watch grades need play history tracking on at least one media server, so there is nothing to preview."}
          </p>
        )}
        {preview?.result.enabled && preview.result.current && preview.result.proposed && (
          <div className={stale ? "opacity-50" : undefined} aria-live="polite">
            <div className="overflow-x-auto">
              <table className="text-xs text-zinc-300 border-collapse">
                <thead>
                  <tr className="text-zinc-500">
                    <th scope="col" className="text-left font-medium pr-4 py-1"><span className="sr-only">Settings</span></th>
                    {SPREAD_COLUMNS.map((c) => (
                      <th key={c.key} scope="col" className="text-right font-medium px-2 py-1 whitespace-nowrap">{c.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <th scope="row" className="text-left font-normal text-zinc-500 pr-4 py-1 whitespace-nowrap">Saved now</th>
                    {SPREAD_COLUMNS.map((c) => (
                      <td key={c.key} className="text-right tabular-nums px-2 py-1">{preview.result.current![c.key]}</td>
                    ))}
                  </tr>
                  <tr>
                    <th scope="row" className="text-left font-normal text-zinc-500 pr-4 py-1 whitespace-nowrap">These values</th>
                    {SPREAD_COLUMNS.map((c) => {
                      const changed = preview.result.proposed![c.key] !== preview.result.current![c.key];
                      return (
                        <td key={c.key} className={`text-right tabular-nums px-2 py-1 ${changed ? "text-white font-semibold" : ""}`}>
                          {preview.result.proposed![c.key]}
                        </td>
                      );
                    })}
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="text-xs text-zinc-500 mt-1">
              {preview.result.requesters} requester{preview.result.requesters === 1 ? "" : "s"} with fulfilled requests.
              {stale ? " The values changed since this preview — preview again to update it." : ""}
            </p>
          </div>
        )}
      </div>

      <div className="flex items-center gap-3 pt-2">
        <Button type="submit" disabled={status === "saving"} className="bg-indigo-600 hover:bg-indigo-500">
          {status === "saving" ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
          Save
        </Button>
        {status === "ok" && <CheckCircle className="w-4 h-4 text-green-500" />}
        {status === "error" && <XCircle className="w-4 h-4 text-red-500" />}
        {error && <span className="text-xs text-red-400">{error}</span>}
      </div>
    </form>
  );
}
