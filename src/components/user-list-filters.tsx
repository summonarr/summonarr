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

  return (
    <div className="flex gap-1.5 flex-wrap">
      {options.map((opt) => {
        const isActive = active === opt.value;
        return (
          <button
            key={opt.value || "_all"}
            type="button"
            onClick={() => onSelect(opt.value)}
            className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors border ${
              isActive
                ? "bg-indigo-600 text-white border-indigo-500"
                : "bg-zinc-900 text-zinc-400 border-zinc-800 hover:text-white hover:border-zinc-600"
            }`}
          >
            {opt.label}
            {opt.count !== undefined && (
              <span className={`ml-1.5 text-[10px] ${isActive ? "text-indigo-200" : "text-zinc-600"}`}>
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
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500 pointer-events-none" />
      <input
        type="text"
        value={value}
        onChange={handleChange}
        placeholder={placeholder}
        className="w-full h-9 rounded-lg bg-zinc-900 border border-zinc-800 pl-9 pr-8 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-zinc-600"
      />
      {value && (
        <button
          type="button"
          onClick={handleClear}
          className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded text-zinc-500 hover:text-white hover:bg-zinc-800 transition-colors"
          aria-label="Clear search"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}
