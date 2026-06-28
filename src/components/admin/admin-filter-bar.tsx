"use client";

import { useRouter } from "next/navigation";

const STATUS_TABS = [
  { label: "All",       value: "" },
  { label: "Pending",   value: "PENDING" },
  { label: "Approved",  value: "APPROVED" },
  { label: "Declined",  value: "DECLINED" },
  { label: "Available", value: "AVAILABLE" },
];

const TYPE_TABS = [
  { label: "All",    value: "" },
  { label: "Movies", value: "MOVIE" },
  { label: "TV",     value: "TV" },
];

const SORT_OPTIONS = [
  { label: "Newest first",  value: "newest"    },
  { label: "Oldest first",  value: "oldest"    },
  { label: "Title A–Z",     value: "title"     },
  { label: "Year (newest)", value: "year-desc" },
  { label: "Year (oldest)", value: "year-asc"  },
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
      {/* Same fix as user-list-filters.tsx: flex-wrap instead of
          overflow-x-auto so the 5 status pills wrap to a second row on narrow
          viewports instead of "Available" being clipped at the right edge. */}
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
              className="inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 font-medium transition-colors"
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
              {tab.label}
              <span
                className="ds-mono"
                style={{
                  fontSize: 10,
                  padding: "0 5px",
                  borderRadius: 3,
                  background: active
                    ? "var(--ds-accent-soft)"
                    : "var(--ds-bg-3)",
                  color: active ? "var(--ds-accent)" : "var(--ds-fg-subtle)",
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
                className="inline-flex items-center whitespace-nowrap shrink-0 font-medium transition-colors"
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
                {tab.label}
              </button>
            );
          })}
        </div>

        <select
          value={currentSort}
          onChange={(e) => navigate(currentStatus, e.target.value, currentType)}
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
              {opt.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
