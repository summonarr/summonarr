import { getActivityCalendar } from "./play-history-calendar";
import { getMostRewatched } from "./play-history-leaderboards";
import { getPlayHistoryStats } from "./play-history-stats";

// Pre-populate the activity stats/calendar/rewatched caches for the common time
// windows so the first admin page load after a cache flush is warm. Cron-driven.
export async function warmActivityCache(): Promise<{ warmed: number }> {
  const steps: WarmStep[] = [];
  for (const days of [1, 7, 14, 30, 90]) steps.push({ label: `stats ${days}d`, run: () => getPlayHistoryStats({ days }) });
  steps.push({ label: "calendar", run: () => getActivityCalendar() });
  for (const days of [7, 14, 30]) steps.push({ label: `rewatched ${days}d`, run: () => getMostRewatched({ days }, 10) });
  return runWarmSteps(steps);
}

export interface WarmStep {
  label: string;
  run: () => Promise<unknown>;
}

// One slow or failing step must not leave the later ones cold. The first failure
// is rethrown at the end, so the run still lands as failed in the cron history.
export async function runWarmSteps(steps: readonly WarmStep[]): Promise<{ warmed: number }> {
  let warmed = 0;
  let firstFailure: unknown = null;
  let failed = false;
  for (const step of steps) {
    try {
      await step.run();
      warmed++;
    } catch (err) {
      console.warn(`[play-history] warm ${step.label} failed:`, err);
      if (!failed) {
        failed = true;
        firstFailure = err;
      }
    }
  }
  if (failed) throw firstFailure;
  return { warmed };
}
