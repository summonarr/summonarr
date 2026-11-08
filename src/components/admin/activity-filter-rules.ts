// The Activity filter bar's rules, without React (tests/activity-filter-rules.test.mts).

import { ACTIVITY_MAX_DAYS, ACTIVITY_MIN_DAYS } from "@/lib/activity-days";

// The Custom period field. Every rejected value names why: without a message,
// typing "-5" and pressing Go just left the page unchanged.
export function parseCustomDays(value: string): { ok: true; days: number } | { ok: false; errorKey: string } {
  const trimmed = value.trim();
  if (trimmed === "") return { ok: false, errorKey: "adminActivity.filter.error.empty" };
  const num = Number(trimmed);
  if (!Number.isInteger(num)) return { ok: false, errorKey: "adminActivity.filter.error.whole" };
  if (num < ACTIVITY_MIN_DAYS || num > ACTIVITY_MAX_DAYS) return { ok: false, errorKey: "adminActivity.filter.error.range" };
  return { ok: true, days: num };
}

export interface ActivitySubPage {
  labelKey: string;
  href: string;
  // Active on this exact path only (the overview is every tab's prefix).
  exact?: boolean;
  // The tab reads the period/source/type filters, so links to it carry them.
  filtered?: boolean;
}

export function isSubPageActive(pathname: string, page: ActivitySubPage): boolean {
  if (page.exact) return pathname === page.href;
  return pathname === page.href || pathname.startsWith(page.href + "/");
}

// A tab's link: a filtered tab keeps the current period/source/type, so moving
// between them doesn't reset to the 30-day default. Only those keys ride along;
// one tab's own state (the History table's search, say) stays on that tab.
export function subPageHref(
  page: ActivitySubPage,
  params: { get(key: string): string | null },
  carriedKeys: readonly string[],
): string {
  if (!page.filtered) return page.href;
  const carried = new URLSearchParams();
  for (const key of carriedKeys) {
    const value = params.get(key);
    if (value) carried.set(key, value);
  }
  const qs = carried.toString();
  return qs ? `${page.href}?${qs}` : page.href;
}
