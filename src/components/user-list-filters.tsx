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

  // `flex-wrap gap-1` (not `overflow-x-auto`) so pills wrap to a second row on
  // narrow viewports instead of being clipped off-screen with no visual cue.
  // Wider viewports where the row fits are unaffected — wrap only kicks in when
  // content exceeds the container width.
  //
  // `w-fit` keeps the box tight to its pills instead of stretching. It pairs
  // with the SearchBox change below: every caller sits this next to a
  // <SearchBox> inside a `flex items-center gap-3`, and that box used to be
  // `w-full` even in the row layout. A wrapping flex container's min-content
  // width is ONE PILL, so the w-full sibling could crush this to a single-pill
  // column — Newest/Oldest stacked vertically at 1372px, and the 6-pill type
  // filter on /issues wrapped 4-then-2. Deliberately NOT `shrink-0`: the wrap
  // still has to work when the row genuinely doesn't fit.
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

  // The pending timer closes over the pathname captured when it was scheduled,
  // so one that survives unmount router.push()es back to the route the user just
  // left (and adds a bogus history entry). Same cleanup as live-refresh.tsx.
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

  // The debounced timer must read the LATEST `push`, not the one from the
  // render that armed it. `push` closes over `searchParams`, so a timer holding
  // the keystroke-time identity replays a stale snapshot of every `preserve`d
  // param: type "abc" (timer armed with ?status=PENDING), click the APPROVED
  // pill inside the 350ms window (FilterPills pushes ?status=APPROVED), then
  // the timer fires push("abc") from the old snapshot → ?status=PENDING&q=abc,
  // silently undoing the pill click. Routing through a ref that tracks the
  // current identity makes the eventual URL the combined intent
  // (?status=APPROVED&q=abc). Synced in an effect (not during render) to stay
  // clear of react-hooks' ref-write-in-render rule.
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

  // Full width only when the parent row has collapsed to a column (below `sm`).
  // In the row layout `w-full` made this demand 100% of the line, which is what
  // squeezed the sibling FilterPills into a vertical stack — see the note on
  // that component. `sm:w-auto` lets the row size to its content instead, with
  // a floor so the input stays usable and a cap so it can't sprawl.
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
