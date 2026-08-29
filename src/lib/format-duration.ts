// Two duration formatters that used to be defined as same-named local
// `formatDuration` helpers in different components with INCOMPATIBLE units
// (one milliseconds, one seconds) — a maintenance trap. Distinct names here.

// Milliseconds → "Nms" under a second, "X.Xs" above. For short machine
// timings (cron last-run durations).
export function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// Seconds → "Xh Ym" / "Xm", em-dash for non-positive. For human watch/play
// durations.
export function formatDurationSeconds(seconds: number): string {
  if (seconds <= 0) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
