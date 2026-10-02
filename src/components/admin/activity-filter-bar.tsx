"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useCallback, useState } from "react";
import Link from "next/link";
import { useT } from "@/components/i18n/i18n-provider";

const DATE_RANGES = [
  { label: "7d", value: "7" },
  { label: "14d", value: "14" },
  { label: "30d", value: "30" },
  { label: "90d", value: "90" },
];

// `labelKey` entries are catalog keys translated at render; brand names
// (Plex, Jellyfin) carry a literal `label` instead.
const SOURCES: { label?: string; labelKey?: string; value: string }[] = [
  { labelKey: "adminActivity.filter.all", value: "" },
  { label: "Plex", value: "plex" },
  { label: "Jellyfin", value: "jellyfin" },
];

const MEDIA_TYPES = [
  { labelKey: "adminActivity.filter.all", value: "" },
  { labelKey: "adminActivity.filter.movies", value: "MOVIE" },
  { labelKey: "adminActivity.filter.tv", value: "TV" },
];

const SUB_PAGES: { labelKey: string; href: string; exact?: boolean; tab?: string }[] = [
  { labelKey: "adminActivity.tab.overview", href: "/admin/activity", exact: true },
  { labelKey: "adminActivity.tab.history", href: "/admin/activity", tab: "history" },
  { labelKey: "adminActivity.tab.users", href: "/admin/activity/users" },
  { labelKey: "adminActivity.tab.stats", href: "/admin/activity/stats" },
  { labelKey: "adminActivity.tab.recentlyAdded", href: "/admin/activity/recent" },
];

// Sub-page nav tabs plus period/source/type filters for the admin activity
// pages; filters are driven entirely through URL search params.
export function ActivityFilterBar() {
  const t = useT();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const currentTab = searchParams.get("tab") ?? "";
  const currentDays = searchParams.get("days") ?? "30";
  const currentSource = searchParams.get("source") ?? "";
  const currentMediaType = searchParams.get("mediaType") ?? "";
  const isPreset = DATE_RANGES.some((r) => r.value === currentDays);

  const [showCustom, setShowCustom] = useState(!isPreset && currentDays !== "30");
  const [customValue, setCustomValue] = useState(!isPreset ? currentDays : "");
  const [customError, setCustomError] = useState<string | null>(null);

  // The component is not remounted on a same-route navigation (browser Back
  // from ?days=45 to ?days=7), so the Custom highlight and input would keep
  // their old values. Re-derive them from the URL whenever `days` changes
  // (React's "adjust state during render" pattern, no effect needed).
  const [syncedDays, setSyncedDays] = useState(currentDays);
  if (syncedDays !== currentDays) {
    setSyncedDays(currentDays);
    setShowCustom(!isPreset && currentDays !== "30");
    setCustomValue(!isPreset ? currentDays : "");
    setCustomError(null);
  }

  function isSubPageActive(page: typeof SUB_PAGES[0]): boolean {
    if (page.href === "/admin/activity" && page.exact) {
      return pathname === "/admin/activity" && !currentTab;
    }
    if (page.tab) {
      return pathname === "/admin/activity" && currentTab === page.tab;
    }
    return pathname === page.href || pathname.startsWith(page.href + "/");
  }

  // No `router.refresh()` after the push, on purpose. These pages are
  // `force-dynamic` and Next does not cache dynamic pages on the client
  // (`staleTimes.dynamic` defaults to 0), so `router.push` to the new URL
  // already renders the page fresh on the server. An extra refresh made the
  // heaviest admin page render twice per click. The same holds for the
  // Overview/History tab buttons below.
  const setParam = useCallback(
    (key: string, value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value) {
        params.set(key, value);
      } else {
        params.delete(key);
      }
      const url = `${pathname}?${params.toString()}`;
      router.push(url);
    },
    [router, pathname, searchParams],
  );

  // Every rejected value shows a message. Without one, typing "-5" and pressing
  // Go would just leave the page unchanged, and the user would not know why.
  const applyCustomDays = () => {
    const trimmed = customValue.trim();
    if (trimmed === "") {
      setCustomError(t("adminActivity.filter.error.empty"));
      return;
    }
    const num = Number(trimmed);
    if (!Number.isInteger(num)) {
      setCustomError(t("adminActivity.filter.error.whole"));
      return;
    }
    if (num < 1 || num > 3650) {
      setCustomError(t("adminActivity.filter.error.range"));
      return;
    }
    setCustomError(null);
    setParam("days", String(num));
  };

  const showFilters = pathname === "/admin/activity" || pathname === "/admin/activity/stats";

  return (
    <div className="mb-6 space-y-3">
      {/* Sub-page nav */}
      <div className="flex items-center gap-1 border-b border-zinc-800 pb-3 overflow-x-auto">
        {SUB_PAGES.map((page) => {
          const active = isSubPageActive(page);
          if (page.tab) {
            return (
              <button
                key={page.labelKey}
                onClick={() => router.push(`/admin/activity?tab=${page.tab}`)}
                aria-current={active ? "page" : undefined}
                className={`inline-flex items-center min-h-8 px-3 py-1.5 text-sm font-medium rounded-md whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ds-accent-ring)] ${
                  active
                    ? "bg-zinc-800 text-zinc-100"
                    : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/60"
                }`}
              >
                {t(page.labelKey)}
              </button>
            );
          }
          if (page.href === "/admin/activity" && page.exact) {
            return (
              <button
                key={page.labelKey}
                onClick={() => router.push("/admin/activity")}
                aria-current={active ? "page" : undefined}
                className={`inline-flex items-center min-h-8 px-3 py-1.5 text-sm font-medium rounded-md whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ds-accent-ring)] ${
                  active
                    ? "bg-zinc-800 text-zinc-100"
                    : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/60"
                }`}
              >
                {t(page.labelKey)}
              </button>
            );
          }
          return (
            <Link
              key={page.labelKey}
              href={page.href}
              aria-current={active ? "page" : undefined}
              className={`inline-flex items-center min-h-8 px-3 py-1.5 text-sm font-medium rounded-md whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ds-accent-ring)] ${
                active
                  ? "bg-zinc-800 text-zinc-100"
                  : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/60"
              }`}
            >
              {t(page.labelKey)}
            </Link>
          );
        })}
      </div>

      {/* Filters */}
      {showFilters && (
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex flex-wrap items-center gap-1">
            <span className="text-xs text-zinc-500 mr-1">{t("adminActivity.filter.period")}</span>
            <div className="flex rounded-lg border border-zinc-700 overflow-hidden">
              {DATE_RANGES.map((r) => {
                const selected =
                  !showCustom && (currentDays === r.value || (r.value === "30" && !searchParams.has("days")));
                return (
                <button
                  aria-pressed={selected}
                  key={r.value}
                  onClick={() => {
                    setShowCustom(false);
                    setParam("days", r.value === "30" ? "" : r.value);
                  }}
                  className={`inline-flex items-center min-h-8 px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ds-accent-ring)] ${
                    selected
                      ? "bg-indigo-600 text-[var(--ds-accent-fg)]"
                      : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-100"
                  }`}
                >
                  {r.label}
                </button>
                );
              })}
              <button
                onClick={() => setShowCustom(true)}
                aria-pressed={showCustom}
                className={`inline-flex items-center min-h-8 px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ds-accent-ring)] ${
                  showCustom
                    ? "bg-indigo-600 text-[var(--ds-accent-fg)]"
                    : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-100"
                }`}
              >
                {t("adminActivity.filter.custom")}
              </button>
            </div>
            {showCustom && (
              <div className="flex flex-wrap items-center gap-1 ml-1">
                <input
                  type="number"
                  min={1}
                  max={3650}
                  value={customValue}
                  onChange={(e) => {
                    setCustomValue(e.target.value);
                    // Clear the complaint as soon as they start correcting it.
                    if (customError) setCustomError(null);
                  }}
                  onKeyDown={(e) => e.key === "Enter" && applyCustomDays()}
                  placeholder={t("adminActivity.filter.daysPlaceholder")}
                  aria-label={t("adminActivity.filter.customAria")}
                  aria-invalid={customError ? true : undefined}
                  aria-describedby={customError ? "activity-custom-days-error" : undefined}
                  className={`w-16 min-h-8 px-2 py-1 text-xs bg-zinc-800 border rounded-lg text-zinc-100 placeholder:text-zinc-500 focus:outline-none tabular-nums ${
                    customError
                      ? "border-red-500 focus:border-red-400"
                      : "border-zinc-700 focus:border-indigo-500"
                  }`}
                />
                <button
                  onClick={applyCustomDays}
                  className="inline-flex items-center min-h-8 px-2 py-1 text-xs font-medium bg-indigo-600 text-[var(--ds-accent-fg)] rounded-lg hover:bg-indigo-500 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-accent-ring)]"
                >
                  {t("adminActivity.filter.go")}
                </button>
                {customError && (
                  <span
                    id="activity-custom-days-error"
                    role="alert"
                    className="text-xs text-red-400"
                  >
                    {customError}
                  </span>
                )}
              </div>
            )}
          </div>

          <div className="flex items-center gap-1">
            <span className="text-xs text-zinc-500 mr-1">{t("adminActivity.filter.source")}</span>
            <div className="flex rounded-lg border border-zinc-700 overflow-hidden">
              {SOURCES.map((s) => (
                <button
                  key={s.value}
                  onClick={() => setParam("source", s.value)}
                  aria-pressed={currentSource === s.value}
                  className={`inline-flex items-center min-h-8 px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ds-accent-ring)] ${
                    currentSource === s.value
                      ? "bg-indigo-600 text-[var(--ds-accent-fg)]"
                      : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-100"
                  }`}
                >
                  {s.labelKey ? t(s.labelKey) : s.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-1">
            <span className="text-xs text-zinc-500 mr-1">{t("adminActivity.filter.type")}</span>
            <div className="flex rounded-lg border border-zinc-700 overflow-hidden">
              {MEDIA_TYPES.map((mt) => (
                <button
                  key={mt.value}
                  onClick={() => setParam("mediaType", mt.value)}
                  aria-pressed={currentMediaType === mt.value}
                  className={`inline-flex items-center min-h-8 px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ds-accent-ring)] ${
                    currentMediaType === mt.value
                      ? "bg-indigo-600 text-[var(--ds-accent-fg)]"
                      : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-100"
                  }`}
                >
                  {t(mt.labelKey)}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
