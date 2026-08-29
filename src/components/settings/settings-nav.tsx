"use client";

import { useState, useEffect } from "react";

export interface NavItem {
  id: string;
  label: string;
  group: string;
}

// Scroll-spy sidebar nav: highlights the section nearest the top of <main>.
//
// The entries are plain `#id` anchors, NOT buttons that measure and scroll in
// JS. The previous implementation read getBoundingClientRect() on both the
// section and <main>, then called main.scrollTo() with a hand-computed offset —
// which reportedly moved the page a few dozen pixels and stopped. Handing the
// scroll back to the browser removes the measurement entirely; the offset that
// JS was applying is now `scroll-margin-top` on `.settings-sections > [id]` in
// globals.css. It also means these sections have real deep links, survive JS
// failing to load, and work from the keyboard.
//
// The spy stays: it listens on <main>'s scroll (the (app) layout makes <main>
// the scroll container) purely to move the active pill.
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
                    ? "bg-zinc-800 text-white font-medium"
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
