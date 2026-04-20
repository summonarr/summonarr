"use client";

import { useRouter } from "next/navigation";

const STATUS_TABS = [
  { label: "All",       value: "" },
  { label: "Pending",   value: "PENDING" },
  { label: "Approved",  value: "APPROVED" },
  { label: "Declined",  value: "DECLINED" },
  { label: "Available", value: "AVAILABLE" },
];

const SORT_OPTIONS = [
  { label: "Newest first", value: "newest" },
  { label: "Oldest first", value: "oldest" },
  { label: "Title A–Z",    value: "title"  },
];

interface AdminFilterBarProps {
  statusCounts: Record<string, number>;
  totalAll: number;
  currentStatus: string;
  currentSort: string;
}

export function AdminFilterBar({ statusCounts, totalAll, currentStatus, currentSort }: AdminFilterBarProps) {
  const router = useRouter();

  function navigate(status: string, sort: string) {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (sort && sort !== "newest") params.set("sort", sort);
    const qs = params.toString();
    router.push(`/admin${qs ? `?${qs}` : ""}`);
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
      <div className="flex items-center gap-1 flex-wrap">
        {STATUS_TABS.map((tab) => {
          const count = tab.value ? (statusCounts[tab.value] ?? 0) : totalAll;
          const active = currentStatus === tab.value;
          return (
            <button
              key={tab.value}
              onClick={() => navigate(tab.value, currentSort)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                active
                  ? "bg-indigo-600 text-white"
                  : "text-zinc-400 hover:text-white hover:bg-zinc-800"
              }`}
            >
              {tab.label}
              <span className={`text-[10px] tabular-nums ${active ? "text-indigo-200" : "text-zinc-600"}`}>
                {count}
              </span>
            </button>
          );
        })}
      </div>

      <select
        value={currentSort}
        onChange={(e) => navigate(currentStatus, e.target.value)}
        className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-xs text-zinc-300 focus:outline-none focus:ring-1 focus:ring-indigo-500"
      >
        {SORT_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}
