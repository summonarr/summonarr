"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Search, X } from "@/components/icons";

export function FilterPills({
  param,
  active,
  options,
  preserve,
}: {
  param: string;
  active: string;
  options: Array<{ value: string; label: string; count?: number }>;
  // Other query params to carry over when a pill is clicked. Everything else
  // (e.g. the page number) is dropped.
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

  // `flex-wrap` lets the pills wrap to a second row on narrow screens instead
  // of being clipped off-screen.
  //
  // `w-fit` keeps the box as wide as its pills. Callers put this beside a
  // <SearchBox> in a flex row, and a wrapping flex box can shrink to ONE pill
  // wide, so a greedy sibling could squeeze the pills into a vertical stack.
  // Not `shrink-0`, so it can still wrap when the row truly doesn't fit.
  return (
    <div
      className="flex flex-wrap gap-1 max-w-full w-fit"
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
            aria-pressed={isActive}
            // `ds-hover-tint`: the background is inline, so a :hover background
            // rule can't beat it (guardrail 42). minHeight keeps the tap target
            // at 32px.
            className="ds-hover-tint inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 font-medium"
            style={{
              padding: "5px 12px",
              minHeight: 32,
              borderRadius: 6,
              border: 0,
              fontSize: 12,
              background: isActive ? "var(--ds-bg-3)" : "transparent",
              color: isActive ? "var(--ds-fg)" : "var(--ds-fg-muted)",
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
                    ? "var(--ds-accent-text)"
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

  // Cancel a pending search on unmount. Otherwise the timer would still fire
  // and navigate back to the page the user just left.
  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    },
    [],
  );

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

  // The debounce timer (typing waits 350ms before searching) must call the
  // LATEST `push`, because `push` captures the current URL params. Example:
  // type "abc" while on ?status=PENDING, then click the APPROVED pill before
  // the timer fires. An old `push` would bring back ?status=PENDING and undo
  // the click; the latest one gives ?status=APPROVED&q=abc. The ref is updated
  // in an effect because React's lint rules forbid writing refs during render.
  const pushRef = useRef(push);
  useEffect(() => {
    pushRef.current = push;
  }, [push]);

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const next = e.target.value;
    setValue(next);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => pushRef.current(next), 350);
  }

  function handleClear() {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setValue("");
    push("");
  }

  // Full width only on small screens, where the parent row stacks into a
  // column. From `sm` up it sizes to its content (with a min and max width), so
  // it doesn't squeeze the FilterPills beside it — see the note there.
  return (
    <div className="relative w-full sm:w-auto sm:min-w-[12rem] sm:max-w-xs">
      <div
        className="flex items-center focus-within:ring-2 focus-within:ring-ring"
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
          aria-label={placeholder}
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
              width: 28,
              height: 28,
              borderRadius: 4,
              background: "transparent",
              color: "var(--ds-fg-subtle)",
              border: 0,
              marginLeft: 4,
              marginRight: -4,
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
