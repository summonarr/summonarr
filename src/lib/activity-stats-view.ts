// Pure shaping behind the admin Activity Statistics tab
// (src/components/admin/activity-stats-redesign.tsx): the stream-method
// percentages in its headers and the weekday / hour-of-day buckets. Kept out of
// the "use client" component so the unit suite can pin the arithmetic.

import { OTHER_REASONS } from "./transcode-reasons";
import type { StreamMix } from "./activity-stream-mix";

/** Rounded whole-number share of `total`; 0 when there is nothing to divide by. */
export function sharePct(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 100) : 0;
}

export interface StreamShares {
  /** Every transcoded session: the reason list folds its long tail into "Other reasons". */
  transcodeTotal: number;
  transcodePct: number;
  directPct: number;
  /** The most common NAMED reason — "Other reasons" is a bundle, never a cause. */
  topReason: { reason: string; count: number } | undefined;
  topReasonPct: number;
}

// The method mix counts every session, while the tab's totalPlays counts only
// watched ones, so the percentages divide by the mix's own total — the number
// the stream-type bars sum to, "Other" segment included. Direct play is read
// by name, never by bar position.
export function streamShares(
  mix: StreamMix,
  transcodeReasons: readonly { reason: string; count: number }[],
): StreamShares {
  const transcodeTotal = transcodeReasons.reduce((s, r) => s + r.count, 0);
  const topReason = transcodeReasons.find((r) => r.reason !== OTHER_REASONS);
  return {
    transcodeTotal,
    transcodePct: sharePct(transcodeTotal, mix.total),
    directPct: sharePct(mix.counts.DirectPlay, mix.total),
    topReason,
    topReasonPct: topReason ? sharePct(topReason.count, transcodeTotal) : 0,
  };
}

/** Plays per weekday, Monday first. Postgres numbers weekdays 0=Sun..6=Sat. */
export function weekdayCounts(playsByDow: readonly { dow: number; count: number }[]): number[] {
  return Array.from({ length: 7 }, (_, i) => {
    const dow = (i + 1) % 7;
    return playsByDow.find((d) => d.dow === dow)?.count ?? 0;
  });
}

/** Plays per hour 0..23 in the statistics time zone (guardrail 19g); an hour the SQL didn't return reads 0. */
export function hourCounts(playsByHour: readonly { hour: number; count: number }[]): number[] {
  return Array.from({ length: 24 }, (_, h) => playsByHour.find((p) => p.hour === h)?.count ?? 0);
}

// The busiest bucket, or null when every bucket is empty: indexOf(0) would
// name hour 0, and the caption would read "peak 0:00 · 0 plays".
export function peakBucket(counts: readonly number[]): { index: number; count: number } | null {
  const count = Math.max(0, ...counts);
  return count > 0 ? { index: counts.indexOf(count), count } : null;
}
