"use client";

import { useRouter } from "next/navigation";
import { useT } from "@/components/i18n/i18n-provider";
import { StyledSelect } from "@/components/ui/styled-select";
import { REQUEST_STATUS_LABEL_KEY } from "@/lib/status-labels";

// Labels are i18n keys, translated at render.
const STATUS_TABS = [
  { labelKey: "requests.filter.all", value: "" },
  ...(["PENDING", "APPROVED", "DECLINED", "AVAILABLE"] as const).map((value) => ({
    labelKey: REQUEST_STATUS_LABEL_KEY[value],
    value,
  })),
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

// A segmented control: one pressed button per option, with an optional count.
// Wraps onto a second row on a narrow screen (rather than scrolling, which
// clipped "Available" off the right edge); user-list-filters.tsx does the
// same. The pressed segment is the design FilterBar's: a bg-3 fill alone was
// ~1.07:1 against the bg-1 track in light mode, so it also carries a
// border-strong edge and a small shadow (guardrail 42).
function Segmented<V extends string>({
  options,
  active,
  onChange,
  label,
}: {
  options: readonly { value: V; label: string; count?: number }[];
  active: V;
  onChange: (value: V) => void;
  label: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="flex flex-wrap gap-1 max-w-full"
      style={{
        padding: 2,
        background: "var(--ds-bg-1)",
        border: "1px solid var(--ds-border)",
        borderRadius: 8,
      }}
    >
      {options.map((o) => {
        const isActive = o.value === active;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            aria-pressed={isActive}
            className="ds-hover-tint inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 font-medium transition-colors"
            style={{
              padding: "5px 12px",
              borderRadius: 6,
              border: 0,
              fontSize: 12,
              background: isActive ? "var(--ds-bg-2)" : "transparent",
              // Inactive segments leave box-shadow unset so .ds-hover-tint's
              // inset tint (a box-shadow) shows on hover.
              boxShadow: isActive ? "var(--ds-shadow-sm), inset 0 0 0 1px var(--ds-border-strong)" : undefined,
              color: isActive ? "var(--ds-fg)" : "var(--ds-fg-muted)",
            }}
          >
            {o.label}
            {typeof o.count === "number" && (
              <span
                className="ds-mono"
                style={{
                  fontSize: 10,
                  padding: "0 5px",
                  borderRadius: 3,
                  background: isActive ? "var(--ds-accent-soft)" : "var(--ds-bg-3)",
                  color: isActive ? "var(--ds-accent-text)" : "var(--ds-fg-subtle)",
                }}
              >
                {o.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
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
      <Segmented
        label={t("adminQueue.filter.statusLabel")}
        options={STATUS_TABS.map((tab) => ({
          value: tab.value,
          label: t(tab.labelKey),
          count: tab.value ? (statusCounts[tab.value] ?? 0) : totalAll,
        }))}
        active={currentStatus}
        onChange={(status) => navigate(status, currentSort, currentType)}
      />

      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          label={t("adminQueue.filter.typeLabel")}
          options={TYPE_TABS.map((tab) => ({ value: tab.value, label: t(tab.labelKey) }))}
          active={currentType}
          onChange={(type) => navigate(currentStatus, currentSort, type)}
        />

        <StyledSelect
          compact
          value={currentSort}
          onChange={(e) => navigate(currentStatus, e.target.value, currentType)}
          aria-label={t("adminQueue.sort.label")}
          className="w-auto md:text-xs"
        >
          {SORT_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {t(opt.labelKey)}
            </option>
          ))}
        </StyledSelect>
      </div>
    </div>
  );
}
