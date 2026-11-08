"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import { fetchJson } from "@/lib/client/fetch-json";
import { v, type Infer } from "@/lib/validate";
import { useAsyncAction } from "@/hooks/use-async-action";
import { NumberField } from "./forms/number-field";
import { useT } from "@/components/i18n/i18n-provider";
import { SaveStatusMessage } from "./forms/save-status";
import { saveFailureText, useSettingsSave } from "./forms/shared";
import {
  WATCH_GRADE_DEFAULTS,
  WATCH_GRADE_SETTING_KEYS,
  type WatchGradeSpread,
} from "@/lib/watch-grade";

type Field = keyof typeof WATCH_GRADE_SETTING_KEYS;

// A null i18nKey means the column header is the grade letter itself.
const SPREAD_COLUMNS: { key: keyof WatchGradeSpread; i18nKey: string | null }[] = [
  { key: "A", i18nKey: null },
  { key: "B", i18nKey: null },
  { key: "C", i18nKey: null },
  { key: "D", i18nKey: null },
  { key: "F", i18nKey: null },
  { key: "notGraded", i18nKey: "settings.watchGrade.notGraded" },
];

// POST /api/admin/watch-grade/preview (WatchGradePreview), checked: the table
// reads every column of both spreads.
const Spread = v.object({ A: v.number(), B: v.number(), C: v.number(), D: v.number(), F: v.number(), notGraded: v.number() });
const PreviewAnswer = v.object({
  enabled: v.boolean(),
  reason: v.nullable(v.literal("feature-off", "tracking-off")),
  requesters: v.number(),
  current: v.nullable(Spread),
  proposed: v.nullable(Spread),
});

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
  const t = useT();
  const [values, setValues] = useState<Record<Field, string>>(initial);
  const [preview, setPreview] = useState<{ body: string; result: Infer<typeof PreviewAnswer> } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const action = useAsyncAction();
  const previewing = action.busy("preview");

  // An edit during a save keeps Save locked and isn't reported as saved
  // (useSettingsSave). Only a success fades; an error keeps its icon beside
  // its message until the next edit or save.
  const { status, message, save, edited } = useSettingsSave();

  function set(field: Field, value: string) {
    setValues((prev) => ({ ...prev, [field]: value }));
    edited();
  }

  // What both Save and Preview send: every watch-grade key, trimmed.
  const fields = useMemo(() => {
    const out: Record<string, string> = {};
    for (const field of Object.keys(WATCH_GRADE_SETTING_KEYS) as Field[]) {
      out[WATCH_GRADE_SETTING_KEYS[field]] = values[field].trim();
    }
    return out;
  }, [values]);
  const body = useMemo(() => JSON.stringify(fields), [fields]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    const result = await save(fields, saveFailureText(t));
    // The preview's "Now" row described the settings just replaced.
    if (result.ok) setPreview(null);
  }

  async function handlePreview() {
    const sent = body;
    setPreviewError(null);
    const res = await action.run("preview", (signal) => fetchJson(withBasePath("/api/admin/watch-grade/preview"), {
      init: { method: "POST", headers: { "Content-Type": "application/json" }, body: sent },
      schema: PreviewAnswer,
      signal,
    }));
    if (!res) return;
    if (!res.ok) {
      setPreviewError(
        res.kind === "http"
          ? res.error || t("settings.watchGrade.previewFailedStatus", { status: res.status })
          : res.kind === "invalid"
            ? t("settings.watchGrade.previewFailedStatus", { status: res.status })
            : t("settings.common.networkError"),
      );
      return;
    }
    setPreview({ body: sent, result: res.data });
  }

  const stale = preview !== null && preview.body !== body;
  const spreads = preview?.result.enabled && preview.result.current && preview.result.proposed
    ? { current: preview.result.current, proposed: preview.result.proposed, requesters: preview.result.requesters }
    : null;

  const numberField = (
    field: Field,
    id: string,
    label: string,
    bounds: { min: number; max: number },
    help: React.ReactNode,
  ) => (
    <NumberField
      id={id}
      label={label}
      min={bounds.min}
      max={bounds.max}
      placeholder={String(WATCH_GRADE_DEFAULTS[field])}
      value={values[field]}
      onChange={(value) => set(field, value)}
      help={help}
    />
  );

  return (
    <form onSubmit={handleSave} className="space-y-5">
      {numberField("graceDays", "watch-grade-grace", t("settings.watchGrade.grace"), { min: 1, max: 365 },
        t("settings.watchGrade.graceHelp", { default: WATCH_GRADE_DEFAULTS.graceDays }),
      )}

      {numberField("windowDays", "watch-grade-window", t("settings.watchGrade.window"), { min: 0, max: 3650 },
        t("settings.watchGrade.windowHelp", { default: WATCH_GRADE_DEFAULTS.windowDays }),
      )}

      {numberField("tvEpisodePercent", "watch-grade-tv", t("settings.watchGrade.tvPercent"), { min: 1, max: 100 },
        t("settings.watchGrade.tvPercentHelp", { default: WATCH_GRADE_DEFAULTS.tvEpisodePercent }),
      )}

      {numberField("otherViewers", "watch-grade-others", t("settings.watchGrade.otherViewers"), { min: 0, max: 100 },
        t("settings.watchGrade.otherViewersHelp", { default: WATCH_GRADE_DEFAULTS.otherViewers }),
      )}

      <fieldset className="space-y-1.5">
        <legend className="text-sm font-medium leading-none mb-1.5">{t("settings.watchGrade.cutoffs")}</legend>
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
                className="bg-zinc-800 border-zinc-700 w-20"
              />
            </div>
          ))}
        </div>
        <p className="text-xs text-zinc-500">
          {t("settings.watchGrade.cutoffsHelp", {
            a: WATCH_GRADE_DEFAULTS.bandA,
            b: WATCH_GRADE_DEFAULTS.bandB,
            c: WATCH_GRADE_DEFAULTS.bandC,
            d: WATCH_GRADE_DEFAULTS.bandD,
          })}
        </p>
      </fieldset>

      {numberField("minGradedRequests", "watch-grade-min-requests", t("settings.watchGrade.minRequests"), { min: 1, max: 100 },
        t("settings.watchGrade.minRequestsHelp", { default: WATCH_GRADE_DEFAULTS.minGradedRequests }),
      )}

      <div className="space-y-2 pt-2 border-t border-zinc-800">
        <h3 className="text-sm font-medium text-zinc-300 pt-2">{t("settings.watchGrade.howTitle")}</h3>
        <p className="text-xs text-zinc-500">
          {t("settings.watchGrade.howBody")}
        </p>
      </div>

      <div className="space-y-2 pt-2 border-t border-zinc-800">
        <div className="flex items-center gap-3 pt-2">
          <h3 className="text-sm font-medium text-zinc-300">{t("settings.watchGrade.preview")}</h3>
          <Button type="button" variant="outline" size="sm" onClick={handlePreview} disabled={previewing}>
            {previewing ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : null}
            {preview ? t("settings.watchGrade.previewAgain") : t("settings.watchGrade.previewValues")}
          </Button>
        </div>
        <p className="text-xs text-zinc-500">
          {t("settings.watchGrade.previewHelp")}
        </p>
        {previewError && <p role="alert" className="text-xs text-red-400">{previewError}</p>}
        {preview && !preview.result.enabled && (
          <p className="text-xs text-zinc-400">
            {preview.result.reason === "feature-off"
              ? t("settings.watchGrade.previewFeatureOff")
              : t("settings.watchGrade.previewNoHistory")}
          </p>
        )}
        {spreads && (
          <div className={stale ? "opacity-50" : undefined} aria-live="polite">
            <div className="overflow-x-auto">
              <table className="text-xs text-zinc-300 border-collapse">
                <thead>
                  <tr className="text-zinc-500">
                    <th scope="col" className="text-left font-medium pr-4 py-1"><span className="sr-only">{t("settings.watchGrade.settingsColumn")}</span></th>
                    {SPREAD_COLUMNS.map((c) => (
                      <th key={c.key} scope="col" className="text-right font-medium px-2 py-1 whitespace-nowrap">{c.i18nKey ? t(c.i18nKey) : c.key}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <th scope="row" className="text-left font-normal text-zinc-500 pr-4 py-1 whitespace-nowrap">{t("settings.watchGrade.savedNow")}</th>
                    {SPREAD_COLUMNS.map((c) => (
                      <td key={c.key} className="text-right tabular-nums px-2 py-1">{spreads.current[c.key]}</td>
                    ))}
                  </tr>
                  <tr>
                    <th scope="row" className="text-left font-normal text-zinc-500 pr-4 py-1 whitespace-nowrap">{t("settings.watchGrade.theseValues")}</th>
                    {SPREAD_COLUMNS.map((c) => {
                      const changed = spreads.proposed[c.key] !== spreads.current[c.key];
                      return (
                        <td key={c.key} className={`text-right tabular-nums px-2 py-1 ${changed ? "text-zinc-100 font-semibold" : ""}`}>
                          {spreads.proposed[c.key]}
                        </td>
                      );
                    })}
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="text-xs text-zinc-500 mt-1">
              {t("settings.watchGrade.requesters", { count: spreads.requesters })}
              {stale ? ` ${t("settings.watchGrade.stale")}` : ""}
            </p>
          </div>
        )}
      </div>

      <div className="flex items-center gap-3 pt-2">
        <Button type="submit" disabled={status === "saving"} className="bg-indigo-600 hover:bg-indigo-500">
          {status === "saving" ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
          {t("settings.common.save")}
        </Button>
        {/* Announced either way: "Saved" in a polite live region, the error
            in an assertive one (an edit resets `status`, so both leave). */}
        <SaveStatusMessage status={status} errorLabel={message || undefined} />
      </div>
    </form>
  );
}
