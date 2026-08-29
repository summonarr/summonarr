"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useCallback, useState } from "react";
import Link from "next/link";

const DATE_RANGES = [
  { label: "7d", value: "7" },
  { label: "14d", value: "14" },
  { label: "30d", value: "30" },
  { label: "90d", value: "90" },
];

const SOURCES = [
  { label: "All", value: "" },
  { label: "Plex", value: "plex" },
  { label: "Jellyfin", value: "jellyfin" },
];

const MEDIA_TYPES = [
  { label: "All", value: "" },
  { label: "Movies", value: "MOVIE" },
  { label: "TV", value: "TV" },
];

const SUB_PAGES = [
  { label: "Overview", href: "/admin/activity", exact: true },
  { label: "History", href: "/admin/activity", tab: "history" },
  { label: "Users", href: "/admin/activity/users" },
  { label: "Stats", href: "/admin/activity/stats" },
  { label: "Recently Added", href: "/admin/activity/recent" },
];

// Sub-page nav tabs plus period/source/type filters for the admin activity
// pages; filters are driven entirely through URL search params.
export function ActivityFilterBar() {
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

  function isSubPageActive(page: typeof SUB_PAGES[0]): boolean {
    if (page.href === "/admin/activity" && page.exact) {
      return pathname === "/admin/activity" && !currentTab;
    }
    if (page.tab) {
      return pathname === "/admin/activity" && currentTab === page.tab;
    }
    return pathname === page.href || pathname.startsWith(page.href + "/");
  }

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
      router.refresh();
    },
    [router, pathname, searchParams],
  );

  // Rejecting an out-of-range value is right; doing it in silence was not.
  // Previously this was the `if` alone with no `else`, so "-5" or "99999" left
  // the page on its previous range with no message and the field unchanged —
  // there was nothing to tell the user their input had been thrown away, so
  // the natural response was to press Go again.
  const applyCustomDays = () => {
    const trimmed = customValue.trim();
    if (trimmed === "") {
      setCustomError("Enter a number of days.");
      return;
    }
    const num = Number(trimmed);
    if (!Number.isInteger(num)) {
      setCustomError("Whole days only.");
      return;
    }
    if (num < 1 || num > 3650) {
      setCustomError("Pick between 1 and 3650 days.");
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
                key={page.label}
                onClick={() => {
                  router.push(`/admin/activity?tab=${page.tab}`);
                  router.refresh();
                }}
                className={`px-3 py-1.5 text-sm font-medium rounded-md whitespace-nowrap transition-colors ${
                  active
                    ? "bg-zinc-800 text-white"
                    : "text-zinc-500 hover:text-zinc-300"
                }`}
              >
                {page.label}
              </button>
            );
          }
          if (page.href === "/admin/activity" && page.exact) {
            return (
              <button
                key={page.label}
                onClick={() => {
                  router.push("/admin/activity");
                  router.refresh();
                }}
                className={`px-3 py-1.5 text-sm font-medium rounded-md whitespace-nowrap transition-colors ${
                  active
                    ? "bg-zinc-800 text-white"
                    : "text-zinc-500 hover:text-zinc-300"
                }`}
              >
                {page.label}
              </button>
            );
          }
          return (
            <Link
              key={page.label}
              href={page.href}
              className={`px-3 py-1.5 text-sm font-medium rounded-md whitespace-nowrap transition-colors ${
                active
                  ? "bg-zinc-800 text-white"
                  : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {page.label}
            </Link>
          );
        })}
      </div>

      {/* Filters */}
      {showFilters && (
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-1">
            <span className="text-xs text-zinc-500 mr-1">Period</span>
            <div className="flex rounded-lg border border-zinc-700 overflow-hidden">
              {DATE_RANGES.map((r) => (
                <button
                  key={r.value}
                  onClick={() => {
                    setShowCustom(false);
                    setParam("days", r.value === "30" ? "" : r.value);
                  }}
                  className={`px-2.5 py-1 text-xs font-medium transition-colors ${
                    !showCustom && (currentDays === r.value || (r.value === "30" && !searchParams.has("days")))
                      ? "bg-indigo-600 text-white"
                      : "bg-zinc-800 text-zinc-400 hover:text-white"
                  }`}
                >
                  {r.label}
                </button>
              ))}
              <button
                onClick={() => setShowCustom(true)}
                className={`px-2.5 py-1 text-xs font-medium transition-colors ${
                  showCustom
                    ? "bg-indigo-600 text-white"
                    : "bg-zinc-800 text-zinc-400 hover:text-white"
                }`}
              >
                Custom
              </button>
            </div>
            {showCustom && (
              <div className="flex items-center gap-1 ml-1">
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
                  placeholder="days"
                  aria-label="Custom range in days"
                  aria-invalid={customError ? true : undefined}
                  aria-describedby={customError ? "activity-custom-days-error" : undefined}
                  className={`w-16 px-2 py-1 text-xs bg-zinc-800 border rounded-lg text-white placeholder:text-zinc-500 focus:outline-none tabular-nums ${
                    customError
                      ? "border-red-500 focus:border-red-400"
                      : "border-zinc-700 focus:border-indigo-500"
                  }`}
                />
                <button
                  onClick={applyCustomDays}
                  className="px-2 py-1 text-xs font-medium bg-indigo-600 text-white rounded-lg hover:bg-indigo-500 transition-colors"
                >
                  Go
                </button>
                {customError && (
                  <span
                    id="activity-custom-days-error"
                    role="alert"
                    className="text-xs text-red-400 whitespace-nowrap"
                  >
                    {customError}
                  </span>
                )}
              </div>
            )}
          </div>

          <div className="flex items-center gap-1">
            <span className="text-xs text-zinc-500 mr-1">Source</span>
            <div className="flex rounded-lg border border-zinc-700 overflow-hidden">
              {SOURCES.map((s) => (
                <button
                  key={s.value}
                  onClick={() => setParam("source", s.value)}
                  className={`px-2.5 py-1 text-xs font-medium transition-colors ${
                    currentSource === s.value
                      ? "bg-indigo-600 text-white"
                      : "bg-zinc-800 text-zinc-400 hover:text-white"
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-1">
            <span className="text-xs text-zinc-500 mr-1">Type</span>
            <div className="flex rounded-lg border border-zinc-700 overflow-hidden">
              {MEDIA_TYPES.map((t) => (
                <button
                  key={t.value}
                  onClick={() => setParam("mediaType", t.value)}
                  className={`px-2.5 py-1 text-xs font-medium transition-colors ${
                    currentMediaType === t.value
                      ? "bg-indigo-600 text-white"
                      : "bg-zinc-800 text-zinc-400 hover:text-white"
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
