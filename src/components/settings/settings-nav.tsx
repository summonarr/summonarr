"use client";

import { useState, useEffect } from "react";

export interface NavItem {
  id: string;
  label: string;
  group: string;
}

// Scroll-spy sidebar nav: highlights the section nearest the top of <main>.
//
// The entries are plain `#id` links, so the BROWSER does the scrolling. An
// older version measured positions and scrolled in JS, and it sometimes
// stopped short. The gap above each section now comes from `scroll-margin-top`
// on `.settings-sections > [id]` in globals.css. Plain links also give real
// deep links and work from the keyboard or without JS.
//
// The scroll listener below only moves the highlighted pill. It listens on
// <main> because the (app) layout makes <main> the scrolling element.
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

  const groups = items.reduce<Record<string, NavItem[]>>((acc, item) => {
    (acc[item.group] ??= []).push(item);
    return acc;
  }, {});

  return (
    <nav className="space-y-5">
      {Object.entries(groups).map(([group, groupItems]) => (
        <div key={group}>
          <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1.5 px-3">
            {group}
          </p>
          <div className="space-y-0.5">
            {groupItems.map(({ id, label }) => (
              <a
                key={id}
                href={`#${id}`}
                // The spy would set this on the next scroll event anyway, but
                // doing it on click makes the pill move with the page rather
                // than a frame behind it.
                onClick={() => setActiveId(id)}
                aria-current={activeId === id ? "true" : undefined}
                className={`block w-full text-left text-sm px-3 py-1.5 rounded-md transition-colors ${
                  activeId === id
                    ? "bg-zinc-800 text-zinc-100 font-medium"
                    : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50"
                }`}
              >
                {label}
              </a>
            ))}
          </div>
        </div>
      ))}
    </nav>
  );
}
