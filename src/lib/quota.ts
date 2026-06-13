// Per-media-type request-quota resolution.
//
// Each media type (MOVIE / TV) is quota'd independently — the Overseerr model.
// Resolution order for a type:
//   1. Per-user override (movieQuotaLimit/Days or tvQuotaLimit/Days) — a rolling
//      N-day window. Wins when the limit column is non-null.
//   2. Global Settings (quotaLimit + quotaPeriod) — the existing calendar window
//      (day / ISO-week / month), now applied to each type separately.
// QUOTA_UNLIMITED / ADMIN bypass quotas entirely — checked by the caller via the
// permission bitmask, not here.
//
// NOTE: this makes the global quota per-type. Before this change a single global
// quotaLimit counted movie+TV requests combined; now a user gets that allowance
// for movies AND for TV. Deployments with quota disabled (quotaLimit=0, the
// default) are unaffected.
//
// Server-only leaf module (no imports). `new Date()` is fine here — never runs in
// a client render path (guardrail 16).

export interface UserQuotaOverrides {
  movieQuotaLimit: number | null;
  movieQuotaDays: number | null;
  tvQuotaLimit: number | null;
  tvQuotaDays: number | null;
}

export interface ResolvedQuota {
  // Max non-declined requests of this media type within the window. <= 0 means
  // "no quota applies".
  limit: number;
  // Window start (inclusive) — count requests with createdAt >= since.
  since: Date;
  // Human label for quota-exceeded messages, e.g. "week" or "7 days".
  windowLabel: string;
}

function globalWindow(period: string, now: Date): { since: Date; label: string } {
  if (period === "day") {
    return { since: new Date(now.getFullYear(), now.getMonth(), now.getDate()), label: "day" };
  }
  if (period === "month") {
    return { since: new Date(now.getFullYear(), now.getMonth(), 1), label: "month" };
  }
  // ISO week (Monday start): JS Sunday(0) maps to position 6.
  const day = now.getDay() === 0 ? 6 : now.getDay() - 1;
  return {
    since: new Date(now.getFullYear(), now.getMonth(), now.getDate() - day),
    label: "week",
  };
}

export function resolveUserQuota(
  mediaType: "MOVIE" | "TV",
  overrides: UserQuotaOverrides,
  globalLimit: number,
  globalPeriod: string,
  now: Date = new Date(),
): ResolvedQuota {
  const ovLimit = mediaType === "MOVIE" ? overrides.movieQuotaLimit : overrides.tvQuotaLimit;
  const ovDays = mediaType === "MOVIE" ? overrides.movieQuotaDays : overrides.tvQuotaDays;

  if (ovLimit != null) {
    const days = ovDays && ovDays > 0 ? ovDays : 7;
    return {
      limit: ovLimit,
      since: new Date(now.getTime() - days * 86_400_000),
      windowLabel: `${days} days`,
    };
  }

  const { since, label } = globalWindow(globalPeriod, now);
  return { limit: globalLimit, since, windowLabel: label };
}

// Parse the global `quotaLimit` Setting into a non-negative integer. A non-numeric
// or corrupted value coerces to 0 ("quota disabled") deliberately rather than NaN:
// NaN slips past every `limit > 0` enforcement check and silently turns quotas off
// with no error or signal.
export function parseQuotaLimit(value: string | null | undefined): number {
  const n = Number.parseInt(value ?? "0", 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
