import { getActivityCalendar } from "./play-history-calendar";
import { getMostRewatched } from "./play-history-leaderboards";
import { getPlayHistoryStats } from "./play-history-stats";

// Pre-populate the activity stats/calendar/rewatched caches for the common time
// windows so the first admin page load after a cache flush is warm. Cron-driven.
export async function warmActivityCache(): Promise<{ warmed: number }> {
  let warmed = 0;

  for (const days of [1, 7, 14, 30, 90]) {
    await getPlayHistoryStats({ days });
    warmed++;
  }

  await getActivityCalendar();
  warmed++;

  for (const days of [7, 14, 30]) {
    await getMostRewatched({ days }, 10);
    warmed++;
  }

  return { warmed };
}
