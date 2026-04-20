"use client";

import { useState, useEffect } from "react";

export interface NavItem {
  id: string;
  label: string;
  group: string;
}

export function SettingsNav({ items }: { items: NavItem[] }) {
  const [activeId, setActiveId] = useState<string>(items[0]?.id ?? "");

  useEffect(() => {
    const main = document.querySelector("main");
    if (!main) return;

    function onScroll() {
      const mainRect = main!.getBoundingClientRect();
      let current = items[0]?.id ?? "";
      for (const { id } of items) {
        const el = document.getElementById(id);
        if (!el) continue;
        if (el.getBoundingClientRect().top - mainRect.top <= 80) {
          current = id;
        }
      }
      setActiveId(current);
    }

    main.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => main.removeEventListener("scroll", onScroll);
  }, [items]);

  function scrollTo(id: string) {
    const el = document.getElementById(id);
    const main = document.querySelector("main");
    if (!el || !main) return;
    const mainRect = main.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    main.scrollTo({ top: main.scrollTop + elRect.top - mainRect.top - 24, behavior: "smooth" });
  }

  const groups = items.reduce<Record<string, NavItem[]>>((acc, item) => {
    (acc[item.group] ??= []).push(item);
    return acc;
  }, {});

  return (
    <nav className="space-y-5">
      {Object.entries(groups).map(([group, groupItems]) => (
        <div key={group}>
          <p className="text-xs font-semibold text-zinc-600 uppercase tracking-wider mb-1.5 px-3">
            {group}
          </p>
          <div className="space-y-0.5">
            {groupItems.map(({ id, label }) => (
              <button
                key={id}
                onClick={() => scrollTo(id)}
                className={`w-full text-left text-sm px-3 py-1.5 rounded-md transition-colors ${
                  activeId === id
                    ? "bg-zinc-800 text-white font-medium"
                    : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      ))}
    </nav>
  );
}
