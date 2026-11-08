"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useCallback, useState } from "react";
import Link from "next/link";
import { useT } from "@/components/i18n/i18n-provider";
import { LabelledSegGroup } from "@/components/admin/activity-seg-group";
import {
  ACTIVITY_DEFAULT_DAYS,
  ACTIVITY_MAX_DAYS,
  ACTIVITY_MIN_DAYS,
  parseActivityDays,
  parseActivityMediaType,
  parseActivitySource,
} from "@/lib/activity-days";
import {
  isSubPageActive,
  parseCustomDays,
  subPageHref,
  type ActivitySubPage,
} from "./activity-filter-rules";

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

// Every tab is a real <Link> (cmd/middle-click opens a new tab, right-click
// offers "Open link"). History is its own route segment, not a `?tab=` of the
// overview, so it gets a table-shaped loading.tsx instead of the KPI skeleton.
// `filtered` tabs read the period/source/type filters, so moving between them
// keeps the current ones instead of resetting to the 30-day default.
const SUB_PAGES: ActivitySubPage[] = [
  { labelKey: "adminActivity.tab.overview", href: "/admin/activity", exact: true, filtered: true },
  { labelKey: "adminActivity.tab.history", href: "/admin/activity/history", filtered: true },
  { labelKey: "adminActivity.tab.users", href: "/admin/activity/users" },
  { labelKey: "adminActivity.tab.stats", href: "/admin/activity/stats", filtered: true },
  { labelKey: "adminActivity.tab.recentlyAdded", href: "/admin/activity/recent" },
];
const FILTER_PARAMS = ["days", "source", "mediaType"] as const;

// One segment of the period / source / type toggles.
function segBtnClass(selected: boolean): string {
  return `inline-flex items-center min-h-8 px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ds-accent-ring)] ${
    selected
      ? "bg-indigo-600 text-[var(--ds-accent-fg)]"
      : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-100"
  }`;
}

const GROUP_LABEL_CLASS = "text-xs text-zinc-500 mr-1";
const GROUP_CLASS = "flex rounded-lg border border-zinc-700 overflow-hidden";

function SubPageNav({ pathname, params }: { pathname: string; params: { get(key: string): string | null } }) {
  const t = useT();
  return (
    <div className="flex items-center gap-1 border-b border-zinc-800 pb-3 overflow-x-auto">
      {SUB_PAGES.map((page) => {
        const active = isSubPageActive(pathname, page);
        return (
          <Link
            key={page.labelKey}
            href={subPageHref(page, params, FILTER_PARAMS)}
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
  );
}

// The period presets plus a Custom number of days. `currentDays` is the window
// the server actually rendered (parseActivityDays), not the raw string.
function PeriodFilter({ currentDays, setDays }: { currentDays: string; setDays: (days: string) => void }) {
  const t = useT();
  const isPreset = DATE_RANGES.some((r) => r.value === currentDays);
  const defaultDays = String(ACTIVITY_DEFAULT_DAYS);

  const [showCustom, setShowCustom] = useState(!isPreset && currentDays !== defaultDays);
  const [customValue, setCustomValue] = useState(!isPreset ? currentDays : "");
  const [customError, setCustomError] = useState<string | null>(null);

  // The component is not remounted on a same-route navigation (browser Back
  // from ?days=45 to ?days=7), so the Custom highlight and input would keep
  // their old values. Re-derive them from the URL whenever `days` changes
  // (React's "adjust state during render" pattern, no effect needed).
  const [syncedDays, setSyncedDays] = useState(currentDays);
  if (syncedDays !== currentDays) {
    setSyncedDays(currentDays);
    setShowCustom(!isPreset && currentDays !== defaultDays);
    setCustomValue(!isPreset ? currentDays : "");
    setCustomError(null);
  }

  const applyCustomDays = () => {
    const parsed = parseCustomDays(customValue);
    if (!parsed.ok) {
      setCustomError(t(parsed.errorKey));
      return;
    }
    setCustomError(null);
    setDays(String(parsed.days));
  };

  const customField = showCustom && (
    <div className="flex flex-wrap items-center gap-1 ml-1">
      <input
        type="number"
        min={ACTIVITY_MIN_DAYS}
        max={ACTIVITY_MAX_DAYS}
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
  );

  return (
    <LabelledSegGroup
      label={t("adminActivity.filter.period")}
      className="flex flex-wrap items-center gap-1"
      labelClassName={GROUP_LABEL_CLASS}
      groupClassName={GROUP_CLASS}
      after={customField}
    >
      {DATE_RANGES.map((r) => {
        const selected = !showCustom && currentDays === r.value;
        return (
          <button
            aria-pressed={selected}
            key={r.value}
            onClick={() => {
              setShowCustom(false);
              setDays(r.value === defaultDays ? "" : r.value);
            }}
            className={segBtnClass(selected)}
          >
            {r.label}
          </button>
        );
      })}
      <button
        onClick={() => setShowCustom(true)}
        aria-pressed={showCustom}
        className={segBtnClass(showCustom)}
      >
        {t("adminActivity.filter.custom")}
      </button>
    </LabelledSegGroup>
  );
}

// The Source or Type toggles: one URL parameter, one pressed segment.
function SegmentFilter({
  label,
  options,
  current,
  onPick,
}: {
  label: string;
  options: { label?: string; labelKey?: string; value: string }[];
  current: string;
  onPick: (value: string) => void;
}) {
  const t = useT();
  return (
    <LabelledSegGroup
      label={label}
      className="flex items-center gap-1"
      labelClassName={GROUP_LABEL_CLASS}
      groupClassName={GROUP_CLASS}
    >
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onPick(o.value)}
          aria-pressed={current === o.value}
          className={segBtnClass(current === o.value)}
        >
          {o.labelKey ? t(o.labelKey) : o.label}
        </button>
      ))}
    </LabelledSegGroup>
  );
}

// Sub-page nav tabs plus period/source/type filters for the admin activity
// pages; filters are driven entirely through URL search params.
export function ActivityFilterBar() {
  const t = useT();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // The window the server actually rendered, not the raw string: `?days=0` or
  // `?days=abc` render 30 days, and the bar must say so rather than "Custom: 0".
  const currentDays = String(parseActivityDays(searchParams.get("days")));
  // Likewise for source and type: an unrecognised value renders every source /
  // type, so "All" is the segment that reads as selected.
  const currentSource = parseActivitySource(searchParams.get("source")) ?? "";
  const currentMediaType = parseActivityMediaType(searchParams.get("mediaType")) ?? "";

  // No `router.refresh()` after the push, on purpose. These pages are
  // `force-dynamic` and Next does not cache dynamic pages on the client
  // (`staleTimes.dynamic` defaults to 0), so `router.push` to the new URL
  // already renders the page fresh on the server. An extra refresh made the
  // heaviest admin page render twice per click.
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

  // SUB_PAGES says which tabs read the filters; the bar shows them there only.
  const showFilters = SUB_PAGES.some((p) => p.filtered && isSubPageActive(pathname, p));

  return (
    <div className="mb-6 space-y-3">
      <SubPageNav pathname={pathname} params={searchParams} />

      {showFilters && (
        <div className="flex flex-wrap items-center gap-4">
          <PeriodFilter currentDays={currentDays} setDays={(days) => setParam("days", days)} />
          <SegmentFilter
            label={t("adminActivity.filter.source")}
            options={SOURCES}
            current={currentSource}
            onPick={(value) => setParam("source", value)}
          />
          <SegmentFilter
            label={t("adminActivity.filter.type")}
            options={MEDIA_TYPES}
            current={currentMediaType}
            onPick={(value) => setParam("mediaType", value)}
          />
        </div>
      )}
    </div>
  );
}
