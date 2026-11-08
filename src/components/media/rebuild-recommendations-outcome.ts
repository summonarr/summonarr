// How the For You "Rebuild" button reads POST /api/cron/warm-recommendations
// (rebuild-recommendations-button.tsx). Pure and React-free, so the unit suite
// runs it directly (tests/rebuild-recommendations-outcome.test.mts).
import { check, v } from "@/lib/validate";
import type { FetchJsonResult } from "@/lib/client/fetch-json";

export const RebuildAnswer = v.object({
  error: v.optional(v.string()),
  skipped: v.optional(v.boolean()),
  reason: v.optional(v.string()),
  usersUpdated: v.optional(v.number()),
  usersEligible: v.optional(v.number()),
  usersFailed: v.optional(v.number()),
  graphFailed: v.optional(v.boolean()),
});

type Translate = (key: string, vars?: Record<string, string | number>) => string;

export interface RebuildOutcome {
  text: string;
  type: "success" | "warning" | "error";
  // The server's own words, when it sent any: English, so a tooltip only.
  detail?: string;
  // Seconds before the button can be pressed again.
  cooldown: number;
  // The shelves changed: re-render the server component that reads them.
  refresh: boolean;
}

export function rebuildOutcome(res: FetchJsonResult<unknown>, t: Translate): RebuildOutcome {
  // A rebuild on a large library can outlive a reverse proxy's timeout
  // (~60-100s) while still completing server-side, so a transport failure —
  // or a proxy's own HTML 502/504 page, which fetchJson reads as no answer —
  // must not claim the job failed: say what is actually known.
  if (!res.ok && (res.kind === "network" || res.kind === "timeout")) {
    return { text: t("browse.forYou.rebuild.lostContact"), type: "error", cooldown: 60, refresh: false };
  }
  const parsed = check(RebuildAnswer, res.ok ? res.data : res.body);
  const data = parsed.ok ? parsed.value : {};
  const ok = res.ok;
  const status = res.status;

  // The advisory lock answers {skipped, reason} with a 200 and no `error`, so
  // judging on the status alone would report a rebuild that never started as a
  // success. Checked BEFORE the error branch because a skip is not a failure —
  // the job is already running, which is what the operator wanted.
  if (ok && data.skipped) {
    return { text: t("browse.forYou.rebuild.alreadyRunning"), type: "success", detail: data.reason, cooldown: 30, refresh: false };
  }
  // Finished, but some users failed (200 + `error`): the rest of the shelves —
  // usually the viewer's own — WERE rebuilt, so this is a warning and the grid
  // refreshes. Only graphFailed means nothing changed at all.
  if (ok && data.error && !data.graphFailed) {
    return {
      text: t("browse.forYou.rebuild.partial", {
        updated: data.usersUpdated ?? 0,
        count: data.usersEligible ?? 0,
        failed: data.usersFailed ?? 0,
      }),
      type: "warning",
      detail: data.error,
      cooldown: 60,
      refresh: true,
    };
  }
  if (!ok || data.error) {
    // A failed or graph-failed run changed nothing to show: no refresh.
    return {
      text: data.graphFailed ? t("browse.forYou.rebuild.graphFailed") : t("browse.forYou.rebuild.failed", { status }),
      type: "error",
      detail: data.error,
      cooldown: 30,
      refresh: false,
    };
  }
  // The picks are read from UserRecommendation by a server component, so the
  // grid only changes on a server re-render.
  return {
    text: t("browse.forYou.rebuild.done", { updated: data.usersUpdated ?? 0, count: data.usersEligible ?? 0 }),
    type: "success",
    cooldown: 60,
    refresh: true,
  };
}
