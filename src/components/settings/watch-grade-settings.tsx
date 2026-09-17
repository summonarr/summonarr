"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CheckCircle, XCircle, Loader2 } from "@/components/icons";
import { withBasePath } from "@/lib/base-path";
import { WATCH_GRADE_DEFAULTS, WATCH_GRADE_SETTING_KEYS } from "@/lib/watch-grade";

type SaveStatus = "idle" | "saving" | "ok" | "error";

// Tuning for request watch grades (src/lib/watch-grade.ts). A blank field saves
// as "use the default"; /api/settings enforces the same bounds the grader
// parses with, and its error message is shown verbatim.
export function WatchGradeSettingsForm({
  initialGraceDays,
  initialWindowDays,
  initialTvPercent,
  initialOtherViewers,
}: {
  initialGraceDays: string;
  initialWindowDays: string;
  initialTvPercent: string;
  initialOtherViewers: string;
}) {
  const [graceDays, setGraceDays] = useState(initialGraceDays);
  const [windowDays, setWindowDays] = useState(initialWindowDays);
  const [tvPercent, setTvPercent] = useState(initialTvPercent);
  const [otherViewers, setOtherViewers] = useState(initialOtherViewers);
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setStatus("saving");
    setError(null);
    try {
      const res = await fetch(withBasePath("/api/settings"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          [WATCH_GRADE_SETTING_KEYS.graceDays]: graceDays.trim(),
          [WATCH_GRADE_SETTING_KEYS.windowDays]: windowDays.trim(),
          [WATCH_GRADE_SETTING_KEYS.tvEpisodePercent]: tvPercent.trim(),
          [WATCH_GRADE_SETTING_KEYS.otherViewers]: otherViewers.trim(),
        }),
      });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!res.ok || !data?.ok) {
        setError(data?.error ?? `Save failed (${res.status})`);
        setStatus("error");
        return;
      }
      setStatus("ok");
    } catch {
      setError("Network error — please try again");
      setStatus("error");
    }
    setTimeout(() => setStatus("idle"), 3000);
  }

  return (
    <form onSubmit={handleSave} className="space-y-5">
      <div className="space-y-1.5">
        <Label htmlFor="watch-grade-grace">Grace period (days)</Label>
        <Input
          id="watch-grade-grace"
          type="number"
          min={1}
          max={365}
          placeholder={String(WATCH_GRADE_DEFAULTS.graceDays)}
          value={graceDays}
          onChange={(e) => { setGraceDays(e.target.value); setStatus("idle"); }}
          className="bg-zinc-800 border-zinc-700 text-sm w-32"
        />
        <p className="text-xs text-zinc-500">
          How long after a request becomes available before it counts toward the grade. Requests still inside it are listed but never scored — watched or not — so recent requesters aren&apos;t judged early. Default {WATCH_GRADE_DEFAULTS.graceDays}.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="watch-grade-window">Grade window (days)</Label>
        <Input
          id="watch-grade-window"
          type="number"
          min={0}
          max={3650}
          placeholder={String(WATCH_GRADE_DEFAULTS.windowDays)}
          value={windowDays}
          onChange={(e) => { setWindowDays(e.target.value); setStatus("idle"); }}
          className="bg-zinc-800 border-zinc-700 text-sm w-32"
        />
        <p className="text-xs text-zinc-500">
          Only requests fulfilled within this many days are graded, so a user&apos;s grade reflects recent habits. 30–3650, or 0 for no limit. Keep it longer than the grace period. Default {WATCH_GRADE_DEFAULTS.windowDays}.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="watch-grade-tv">Episodes of a season needed (%)</Label>
        <Input
          id="watch-grade-tv"
          type="number"
          min={1}
          max={100}
          placeholder={String(WATCH_GRADE_DEFAULTS.tvEpisodePercent)}
          value={tvPercent}
          onChange={(e) => { setTvPercent(e.target.value); setStatus("idle"); }}
          className="bg-zinc-800 border-zinc-700 text-sm w-32"
        />
        <p className="text-xs text-zinc-500">
          Share of a season&apos;s regular-season episodes in the library that must be watched for full credit; fewer earns partial credit. Each season is scored on its own and the best one counts, so a finished season keeps its credit as later seasons arrive. Default {WATCH_GRADE_DEFAULTS.tvEpisodePercent}.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="watch-grade-others">Other viewers for credit</Label>
        <Input
          id="watch-grade-others"
          type="number"
          min={0}
          max={100}
          placeholder={String(WATCH_GRADE_DEFAULTS.otherViewers)}
          value={otherViewers}
          onChange={(e) => { setOtherViewers(e.target.value); setStatus("idle"); }}
          className="bg-zinc-800 border-zinc-700 text-sm w-32"
        />
        <p className="text-xs text-zinc-500">
          A request the requester didn&apos;t watch still counts as watched once this many other people have watched it since it was requested. Each counts as play history recorded them — a movie marked Watched, or a season&apos;s episodes to the share above — and someone with both a Plex and a Jellyfin login counts once. 1–100, or 0 to turn it off. Default {WATCH_GRADE_DEFAULTS.otherViewers}.
        </p>
      </div>

      <div className="space-y-2 pt-2 border-t border-zinc-800">
        <h3 className="text-sm font-medium text-zinc-300 pt-2">How grades work</h3>
        <p className="text-xs text-zinc-500">
          Each user is graded A–F on the share of their fulfilled requests they went on to watch: A 80%+, B 60%+, C 40%+, D 20%+, otherwise F, once at least three requests count. A movie counts when it reaches the play history Watched threshold (half credit once a quarter of it is played), a show when the share of one season&apos;s episodes is watched, and any request counts once enough other people have watched it. The same title requested on two instances counts once. Only plays after the request count, and requests fulfilled before play history began recording aren&apos;t graded. Grades are shown to admins only and never block a request.
        </p>
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
