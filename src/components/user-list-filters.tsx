"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Search, X } from "@/components/icons";
import { useT } from "@/components/i18n/i18n-provider";
import { buildParamHref, sameListHref, searchEcho, shouldResyncSearch } from "@/lib/list-filter-url";
import { SEGMENTED_TRACK_STYLE } from "@/components/ui/design/segmented-style";

export function FilterPills({
  param,
  active,
  options,
  preserve,
  label,
}: {
  param: string;
  active: string;
  options: Array<{ value: string; label: string; count?: number }>;
  /** What the pills choose (e.g. "Sort by"). Several groups often sit side by
   *  side, so without it a screen reader hears "Most", "Recent" with no idea
   *  which setting they control. */
  label?: string;
  // Other query params to carry over when a pill is clicked. Everything else
  // (e.g. the page number) is dropped.
  preserve?: string[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // A pill change is a real history step (push), but re-clicking the pill
  // that is already active would only add a duplicate entry.
  const onSelect = useCallback(
    (value: string) => {
      const href = buildParamHref(pathname, searchParams, param, value, preserve);
      if (sameListHref(href, `${pathname}?${searchParams.toString()}`)) return;
      router.push(href);
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
      role="group"
      aria-label={label}
      className="flex flex-wrap gap-1 max-w-full w-fit"
      style={SEGMENTED_TRACK_STYLE}
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
              // FilterBar's raised segment (design/filter-bar.tsx): a bg-3 fill
              // alone was ~1.07:1 against the bg-1 track in light mode, so the
              // active pill also gets a border-strong edge and a small shadow.
              // Inactive pills leave boxShadow unset so .ds-hover-tint's inset
              // tint (a box-shadow) still shows on hover.
              background: isActive ? "var(--ds-bg-2)" : "transparent",
              boxShadow: isActive
                ? "var(--ds-shadow-sm), inset 0 0 0 1px var(--ds-border-strong)"
                : undefined,
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
  placeholder,
  preserve,
}: {
  param: string;
  initial: string;
  // Required: it is also the input's accessible name, and only the caller can
  // translate it (an English default here was a localisation trap).
  placeholder: string;
  preserve?: string[];
}) {
  const t = useT();
  const { value, handleChange, handleClear } = useUrlSearchInput(param, initial, preserve);

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
          // 16px below md: iOS Safari zooms the page when a control under 16px
          // takes focus (same rule as Input and StyledSelect).
          className="flex-1 min-w-0 bg-transparent border-0 outline-none text-base md:text-[13px]"
          style={{ color: "var(--ds-fg)" }}
        />
        {value && (
          <button
            type="button"
            onClick={handleClear}
            aria-label={t("shared.common.clearSearch")}
            // Hover and keyboard focus share one look, in CSS rather than
            // inline styles written from mouse events.
            className="inline-flex items-center justify-center transition-colors bg-transparent text-[var(--ds-fg-subtle)] hover:bg-[var(--ds-bg-3)] hover:text-[var(--ds-fg)] focus-visible:bg-[var(--ds-bg-3)] focus-visible:text-[var(--ds-fg)]"
            style={{
              width: 28,
              height: 28,
              borderRadius: 4,
              border: 0,
              marginLeft: 4,
              marginRight: -4,
            }}
          >
            <X style={{ width: 12, height: 12 }} />
          </button>
        )}
      </div>
    </div>
  );
}

/** The SearchBox's text, its debounced URL write and the resync rules. */
function useUrlSearchInput(param: string, initial: string, preserve: string[] | undefined) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [value, setValue] = useState(initial);

  // What the server will echo back for the last value this box sent to the
  // URL. When our own debounced search lands late (a slow RSC round-trip),
  // `initial` becomes that echo while the user may already have typed more;
  // resyncing then would drop those keystrokes. So resync only when the URL
  // changed from OUTSIDE (back/forward, a pill click, a link). The echo is the
  // page's normalised form (trimmed, LIKE wildcards stripped): comparing the
  // raw text made "star " come back as "star", wipe the input and glue the
  // next word on. A search still waiting to be sent never resyncs either.
  const [lastPushed, setLastPushed] = useState(initial);
  const [pending, setPending] = useState(false);
  const [prevInitial, setPrevInitial] = useState(initial);
  if (initial !== prevInitial) {
    setPrevInitial(initial);
    if (shouldResyncSearch(initial, lastPushed, pending)) {
      setLastPushed(initial);
      setValue(initial);
    }
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

  // REPLACE, not push: every typing pause sends a search, and pushing each
  // one made Back step through "st", "star", "star w"… instead of leaving.
  const navigate = useCallback(
    (next: string) => {
      router.replace(buildParamHref(pathname, searchParams, param, next, preserve));
    },
    [router, pathname, searchParams, param, preserve],
  );

  // The debounce timer (typing waits 350ms before searching) must call the
  // LATEST `navigate`, because it captures the current URL params. Example:
  // type "abc" while on ?status=PENDING, then click the APPROVED pill before
  // the timer fires. An old `navigate` would bring back ?status=PENDING and
  // undo the click; the latest one gives ?status=APPROVED&q=abc. The ref is
  // updated in an effect because React's lint rules forbid writing refs during
  // render.
  const navigateRef = useRef(navigate);
  useEffect(() => {
    navigateRef.current = navigate;
  }, [navigate]);

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const next = e.target.value;
    setValue(next);
    setPending(true);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      setLastPushed(searchEcho(next));
      setPending(false);
      navigateRef.current(next);
    }, 350);
  }

  function handleClear() {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = null;
    setValue("");
    setLastPushed("");
    setPending(false);
    navigate("");
  }

  return { value, handleChange, handleClear };
}
