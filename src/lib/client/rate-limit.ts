// A 429's Retry-After (delta-seconds) → the longest wait shown. The server's
// limiter windows are all under this; anything larger or unparseable (an HTTP
// date, garbage) is treated as "unknown" rather than printing a huge number.
export const RETRY_AFTER_MAX_SECONDS = 3600;

export function parseRetryAfterSeconds(header: string | null | undefined): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (!/^\d{1,6}$/.test(trimmed)) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.min(n, RETRY_AFTER_MAX_SECONDS);
}

type Translate = (key: string, vars?: Record<string, string | number>) => string;

/**
 * User-facing text for a rate-limited response, or null when `res` is not a
 * 429. The wait is named only when Retry-After carried a usable value.
 */
export function rateLimitMessage(res: { status: number; headers: { get(name: string): string | null } }, t: Translate): string | null {
  if (res.status !== 429) return null;
  const seconds = parseRetryAfterSeconds(res.headers.get("Retry-After"));
  return seconds === null
    ? t("shared.rateLimited.generic")
    : t("shared.rateLimited.seconds", { seconds });
}
