"use client";

// Filter bar for the history table: debounced search input (the debounce
// timer itself lives in the parent — this just renders the controlled input),
// date range, export buttons, and the segmented/select filter row. All state
// lives in the parent ActivityHistoryTable; this receives values + setters.

import type { MediaServerUserOption } from "./types";

const inputStyle: React.CSSProperties = {
  fontFamily: "inherit",
  fontSize: 11.5,
  padding: "5px 8px",
  background: "var(--ds-bg-1)",
  color: "var(--ds-fg)",
  border: "1px solid var(--ds-border)",
  borderRadius: 6,
  colorScheme: "dark",
};

function SegGroup<T extends string>({
  label,
  value,
  setValue,
  options,
}: {
  label: string;
  value: T;
  setValue: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span
        className="ds-mono uppercase"
        style={{
          fontSize: 9.5,
          color: "var(--ds-fg-disabled)",
          letterSpacing: "0.08em",
        }}
      >
        {label}
      </span>
      <div
        style={{
          display: "inline-flex",
          padding: 2,
          background: "var(--ds-bg-1)",
          border: "1px solid var(--ds-border)",
          borderRadius: 7,
        }}
      >
        {options.map((o) => (
          <button
            key={o.value}
            onClick={() => setValue(o.value)}
            style={{
              padding: "3px 10px",
              fontSize: 11,
              borderRadius: 5,
              background:
                value === o.value ? "var(--ds-bg-3)" : "transparent",
              color:
                value === o.value
                  ? "var(--ds-fg)"
                  : "var(--ds-fg-muted)",
              border: "1px solid",
              borderColor:
                value === o.value
                  ? "var(--ds-border-strong)"
                  : "transparent",
              cursor: "pointer",
              whiteSpace: "nowrap",
              transition: "all 100ms var(--ds-ease)",
            }}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function SelectField({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span
        className="ds-mono uppercase"
        style={{
          fontSize: 9.5,
          color: "var(--ds-fg-disabled)",
          letterSpacing: "0.08em",
        }}
      >
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          fontFamily: "inherit",
          fontSize: 11.5,
          padding: "4px 26px 4px 9px",
          background: "var(--ds-bg-1)",
          color: value ? "var(--ds-fg)" : "var(--ds-fg-muted)",
          border: "1px solid var(--ds-border)",
          borderRadius: 6,
          appearance: "none",
          WebkitAppearance: "none",
          MozAppearance: "none",
          cursor: "pointer",
        }}
      >
        <option value="">All</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export function HistoryFilterBar({
  search,
  setSearch,
  fromDate,
  setFromDate,
  toDate,
  setToDate,
  watched,
  setWatched,
  method,
  setMethod,
  userFilter,
  setUserFilter,
  platform,
  setPlatform,
  grouped,
  setGrouped,
  users,
  platforms,
  total,
  hasFilter,
  clearFilters,
  exportAs,
}: {
  search: string;
  setSearch: (v: string) => void;
  fromDate: string;
  setFromDate: (v: string) => void;
  toDate: string;
  setToDate: (v: string) => void;
  watched: "" | "true" | "false";
  setWatched: (v: "" | "true" | "false") => void;
  method: string;
  setMethod: (v: string) => void;
  userFilter: string;
  setUserFilter: (v: string) => void;
  platform: string;
  setPlatform: (v: string) => void;
  grouped: boolean;
  setGrouped: (v: boolean) => void;
  users: MediaServerUserOption[];
  platforms: string[];
  total: number;
  hasFilter: boolean;
  clearFilters: () => void;
  exportAs: (format: "csv" | "json") => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 12,
        marginBottom: 14,
      }}
    >
      <div
        className="resp-history-bar"
        style={{ display: "flex", alignItems: "center", gap: 10 }}
      >
        <div style={{ position: "relative", flex: "0 1 360px" }}>
          <svg
            width="13"
            height="13"
            viewBox="0 0 14 14"
            style={{
              position: "absolute",
              left: 10,
              top: "50%",
              transform: "translateY(-50%)",
              color: "var(--ds-fg-subtle)",
            }}
          >
            <circle
              cx="6"
              cy="6"
              r="3.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
            />
            <path
              d="M8.7 8.7L11 11"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          </svg>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by title, user, or IP…"
            style={{
              fontFamily: "inherit",
              fontSize: 12.5,
              width: "100%",
              padding: "7px 30px 7px 30px",
              background: "var(--ds-bg-1)",
              color: "var(--ds-fg)",
              border: "1px solid var(--ds-border)",
              borderRadius: 8,
              outline: "none",
            }}
          />
          {search && (
            <button
              onClick={() => setSearch("")}
              aria-label="Clear search"
              style={{
                position: "absolute",
                right: 8,
                top: "50%",
                transform: "translateY(-50%)",
                background: "transparent",
                border: 0,
                color: "var(--ds-fg-subtle)",
                cursor: "pointer",
                padding: 4,
                lineHeight: 0,
              }}
            >
              <svg width="11" height="11" viewBox="0 0 12 12">
                <path
                  d="M3 3l6 6M9 3l-6 6"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          )}
        </div>

        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <input
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            style={{
              ...inputStyle,
              color: fromDate ? "var(--ds-fg)" : "var(--ds-fg-muted)",
            }}
          />
          <span
            className="ds-mono"
            style={{ fontSize: 11, color: "var(--ds-fg-disabled)" }}
          >
            →
          </span>
          <input
            type="date"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            style={{
              ...inputStyle,
              color: toDate ? "var(--ds-fg)" : "var(--ds-fg-muted)",
            }}
          />
        </div>

        <div style={{ flex: 1 }} />

        <div
          className="ds-mono"
          style={{
            fontSize: 11,
            color: "var(--ds-fg-subtle)",
            fontVariantNumeric: "tabular-nums",
            whiteSpace: "nowrap",
          }}
        >
          {total.toLocaleString("en-US")} total
        </div>

        {hasFilter && (
          <button
            onClick={clearFilters}
            className="ds-mono"
            style={{
              fontSize: 11,
              padding: "5px 10px",
              borderRadius: 6,
              background: "transparent",
              border: "1px solid var(--ds-border)",
              color: "var(--ds-fg-muted)",
              cursor: "pointer",
              whiteSpace: "nowrap",
            }}
          >
            Clear filters
          </button>
        )}

        <div style={{ display: "inline-flex", gap: 4 }}>
          <button
            onClick={() => exportAs("csv")}
            style={{
              fontSize: 12,
              padding: "6px 11px",
              borderRadius: 6,
              background: "var(--ds-bg-2)",
              border: "1px solid var(--ds-border)",
              color: "var(--ds-fg-muted)",
              cursor: "pointer",
              whiteSpace: "nowrap",
            }}
          >
            Export CSV
          </button>
          <button
            onClick={() => exportAs("json")}
            style={{
              fontSize: 12,
              padding: "6px 11px",
              borderRadius: 6,
              background: "var(--ds-bg-2)",
              border: "1px solid var(--ds-border)",
              color: "var(--ds-fg-muted)",
              cursor: "pointer",
              whiteSpace: "nowrap",
            }}
          >
            JSON
          </button>
        </div>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          flexWrap: "wrap",
        }}
      >
        <SegGroup
          label="Watched"
          value={watched}
          setValue={setWatched}
          options={[
            { value: "", label: "All" },
            { value: "true", label: "Yes" },
            { value: "false", label: "No" },
          ]}
        />
        <SegGroup
          label="Stream"
          value={method}
          setValue={setMethod}
          options={[
            { value: "", label: "All" },
            { value: "DirectPlay", label: "Direct" },
            { value: "DirectStream", label: "Remux" },
            { value: "Transcode", label: "Transcode" },
          ]}
        />
        <SelectField
          label="User"
          value={userFilter}
          onChange={setUserFilter}
          options={users.map((u) => ({ value: u.id, label: u.username }))}
        />
        <SelectField
          label="Platform"
          value={platform}
          onChange={setPlatform}
          options={platforms.map((p) => ({ value: p, label: p }))}
        />
        <SegGroup
          label="Group resumes"
          value={grouped ? "on" : "off"}
          setValue={(v) => setGrouped(v === "on")}
          options={[
            { value: "on", label: "On" },
            { value: "off", label: "Off" },
          ]}
        />
      </div>
    </div>
  );
}
