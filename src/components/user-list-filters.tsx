"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Search, X } from "lucide-react";

export function FilterPills({
  param,
  active,
  options,
  preserve,
}: {
  param: string;
  active: string;
  options: Array<{ value: string; label: string; count?: number }>;

  preserve?: string[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const onSelect = useCallback(
    (value: string) => {
      const params = new URLSearchParams();
      if (preserve) {
        for (const key of preserve) {
          const current = searchParams.get(key);
          if (current) params.set(key, current);
        }
      }
      if (value) params.set(param, value);
      router.push(`${pathname}?${params.toString()}`);
    },
    [router, pathname, searchParams, param, preserve],
  );

  // Mobile audit F-4.1: switched from `overflow-x-auto` (with hidden scrollbar)
  // to `flex-wrap gap-1` so pills wrap to a second row on narrow viewports
  // instead of being clipped off-screen with no visual cue. With 5 short status
  // pills on /requests totalling ~464 px, the row now becomes 3+2 on a 440 px
  // viewport. Wider viewports (where the row fits) are unaffected because wrap
  // only kicks in when content exceeds the container width.
  return (
    <div
      className="flex flex-wrap gap-1 max-w-full"
      style={{
        padding: 2,
        background: "var(--ds-bg-1)",
        border: "1px solid var(--ds-border)",
        borderRadius: 8,
      }}
    >
      {options.map((opt) => {
        const isActive = active === opt.value;
        return (
          <button
            key={opt.value || "_all"}
            type="button"
            onClick={() => onSelect(opt.value)}
            className="inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 font-medium transition-colors"
            style={{
              padding: "5px 12px",
              borderRadius: 6,
              border: 0,
              fontSize: 12,
              background: isActive ? "var(--ds-bg-3)" : "transparent",
              color: isActive ? "var(--ds-fg)" : "var(--ds-fg-muted)",
              cursor: "pointer",
            }}
          >
            {opt.label}
            {opt.count !== undefined && (
              <span
                className="ds-mono"
                style={{
                  fontSize: 10,
                  padding: "0 5px",
                  borderRadius: 3,
                  background: isActive
                    ? "var(--ds-accent-soft)"
                    : "var(--ds-bg-3)",
                  color: isActive
                    ? "var(--ds-accent)"
                    : "var(--ds-fg-subtle)",
                }}
              >
                {opt.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export function SearchBox({
  param,
  initial,
  placeholder = "Search…",
  preserve,
}: {
  param: string;
  initial: string;
  placeholder?: string;
  preserve?: string[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [value, setValue] = useState(initial);

  const [prevInitial, setPrevInitial] = useState(initial);
  if (initial !== prevInitial) {
    setPrevInitial(initial);
    setValue(initial);
  }
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const push = useCallback(
    (next: string) => {
      const params = new URLSearchParams();
      if (preserve) {
        for (const key of preserve) {
          const current = searchParams.get(key);
          if (current) params.set(key, current);
        }
      }
      if (next) params.set(param, next);
      router.push(`${pathname}?${params.toString()}`);
    },
    [router, pathname, searchParams, param, preserve],
  );

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const next = e.target.value;
    setValue(next);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => push(next), 350);
  }

  function handleClear() {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setValue("");
    push("");
  }

  return (
    <div className="relative w-full sm:max-w-xs">
      <div
        className="flex items-center"
        style={{
          background: "var(--ds-bg-1)",
          border: "1px solid var(--ds-border)",
          borderRadius: 6,
          height: 32,
          padding: "0 8px 0 10px",
        }}
      >
        <Search
          className="shrink-0"
          style={{ width: 14, height: 14, color: "var(--ds-fg-subtle)", marginRight: 8 }}
        />
        <input
          type="text"
          value={value}
          onChange={handleChange}
          placeholder={placeholder}
          className="flex-1 min-w-0 bg-transparent border-0 outline-none"
          style={{ fontSize: 13, color: "var(--ds-fg)" }}
        />
        {value && (
          <button
            type="button"
            onClick={handleClear}
            aria-label="Clear search"
            className="inline-flex items-center justify-center transition-colors"
            style={{
              width: 20,
              height: 20,
              borderRadius: 4,
              background: "transparent",
              color: "var(--ds-fg-subtle)",
              border: 0,
              marginLeft: 4,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "var(--ds-bg-3)";
              e.currentTarget.style.color = "var(--ds-fg)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "transparent";
              e.currentTarget.style.color = "var(--ds-fg-subtle)";
            }}
          >
            <X style={{ width: 12, height: 12 }} />
          </button>
        )}
      </div>
    </div>
  );
}
