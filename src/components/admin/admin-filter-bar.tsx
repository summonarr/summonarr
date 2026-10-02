"use client";

import { useRouter } from "next/navigation";
import { useT } from "@/components/i18n/i18n-provider";

// Labels are i18n keys, translated at render.
const STATUS_TABS = [
  { labelKey: "requests.filter.all",       value: "" },
  { labelKey: "requests.status.pending",   value: "PENDING" },
  { labelKey: "requests.status.approved",  value: "APPROVED" },
  { labelKey: "requests.status.declined",  value: "DECLINED" },
  { labelKey: "requests.status.available", value: "AVAILABLE" },
];

const TYPE_TABS = [
  { labelKey: "requests.filter.all",  value: "" },
  { labelKey: "search.filter.movies", value: "MOVIE" },
  { labelKey: "search.filter.tv",     value: "TV" },
];

const SORT_OPTIONS = [
  { labelKey: "adminQueue.sort.newest",   value: "newest"    },
  { labelKey: "adminQueue.sort.oldest",   value: "oldest"    },
  { labelKey: "adminQueue.sort.title",    value: "title"     },
  { labelKey: "adminQueue.sort.yearDesc", value: "year-desc" },
  { labelKey: "adminQueue.sort.yearAsc",  value: "year-asc"  },
];

interface AdminFilterBarProps {
  statusCounts: Record<string, number>;
  totalAll: number;
  currentStatus: string;
  currentType: string;
  currentSort: string;
}

export function AdminFilterBar({ statusCounts, totalAll, currentStatus, currentType, currentSort }: AdminFilterBarProps) {
  const router = useRouter();
  const t = useT();

  function navigate(status: string, sort: string, type: string) {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (type) params.set("type", type);
    if (sort && sort !== "newest") params.set("sort", sort);
    const qs = params.toString();
    router.push(`/admin${qs ? `?${qs}` : ""}`);
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
      {/* flex-wrap (not a horizontal scroll) lets the 5 status pills wrap to a
          second row on narrow screens instead of clipping "Available" off the
          right edge. user-list-filters.tsx does the same. */}
      <div
        className="flex flex-wrap gap-1 max-w-full"
        style={{
          padding: 2,
          background: "var(--ds-bg-1)",
          border: "1px solid var(--ds-border)",
          borderRadius: 8,
        }}
      >
        {STATUS_TABS.map((tab) => {
          const count = tab.value ? (statusCounts[tab.value] ?? 0) : totalAll;
          const active = currentStatus === tab.value;
          return (
            <button
              key={tab.value}
              type="button"
              onClick={() => navigate(tab.value, currentSort, currentType)}
              aria-pressed={active}
              className="ds-hover-tint inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 font-medium transition-colors"
              style={{
                padding: "5px 12px",
                borderRadius: 6,
                border: 0,
                fontSize: 12,
                background: active ? "var(--ds-bg-3)" : "transparent",
                color: active ? "var(--ds-fg)" : "var(--ds-fg-muted)",
                cursor: "pointer",
              }}
            >
              {t(tab.labelKey)}
              <span
                className="ds-mono"
                style={{
                  fontSize: 10,
                  padding: "0 5px",
                  borderRadius: 3,
                  background: active
                    ? "var(--ds-accent-soft)"
                    : "var(--ds-bg-3)",
                  color: active ? "var(--ds-accent-text)" : "var(--ds-fg-subtle)",
                }}
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div
          className="flex flex-wrap gap-1 max-w-full"
          style={{
            padding: 2,
            background: "var(--ds-bg-1)",
            border: "1px solid var(--ds-border)",
            borderRadius: 8,
          }}
        >
          {TYPE_TABS.map((tab) => {
            const active = currentType === tab.value;
            return (
              <button
                key={tab.value}
                type="button"
                onClick={() => navigate(currentStatus, currentSort, tab.value)}
                aria-pressed={active}
                className="ds-hover-tint inline-flex items-center whitespace-nowrap shrink-0 font-medium transition-colors"
                style={{
                  padding: "5px 12px",
                  borderRadius: 6,
                  border: 0,
                  fontSize: 12,
                  background: active ? "var(--ds-bg-3)" : "transparent",
                  color: active ? "var(--ds-fg)" : "var(--ds-fg-muted)",
                  cursor: "pointer",
                }}
              >
                {t(tab.labelKey)}
              </button>
            );
          })}
        </div>

        <select
          value={currentSort}
          onChange={(e) => navigate(currentStatus, e.target.value, currentType)}
          aria-label={t("adminQueue.sort.label")}
          className="focus:outline-none focus:ring-1"
          style={{
            padding: "5px 10px",
            height: 30,
            borderRadius: 6,
            fontSize: 12,
            background: "var(--ds-bg-2)",
            color: "var(--ds-fg-muted)",
            border: "1px solid var(--ds-border)",
          }}
        >
          {SORT_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {t(opt.labelKey)}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
