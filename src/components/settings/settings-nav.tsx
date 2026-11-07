"use client";

import { useState, useEffect, useRef } from "react";
import { useT } from "@/components/i18n/i18n-provider";
import { activeSectionId } from "@/lib/client/section-spy";

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
// The scroll listener below only moves the highlighted pill (the rule is
// activeSectionId in section-spy.ts). It listens on <main> because the (app)
// layout makes <main> the scrolling element.
export function SettingsNav({ items }: { items: NavItem[] }) {
  const t = useT();
  const [activeId, setActiveId] = useState<string>(items[0]?.id ?? "");
  // The entry last clicked. At the end of the page it beats "the last section"
  // while it is on screen, until the user scrolls by hand.
  const clickedRef = useRef<string | null>(null);

  useEffect(() => {
    const main = document.querySelector("main");
    if (!main) return;
    const scroller: HTMLElement = main;
    let frame = 0;

    function update() {
      frame = 0;
      const scrollerTop = scroller.getBoundingClientRect().top;
      const sections = items.map(({ id }) => {
        const el = document.getElementById(id);
        return { id, top: el ? el.getBoundingClientRect().top - scrollerTop : null };
      });
      setActiveId(activeSectionId(sections, scroller, clickedRef.current));
    }
    // One measurement per frame, however fast scroll events arrive.
    function onScroll() {
      if (frame === 0) frame = requestAnimationFrame(update);
    }
    // Anchor scrolling fires no wheel, touch, pointer or key event, so any of
    // these means the user is moving the page themselves.
    function onUserScroll() {
      clickedRef.current = null;
    }

    const userEvents = ["wheel", "touchstart", "pointerdown"] as const;
    scroller.addEventListener("scroll", onScroll, { passive: true });
    for (const type of userEvents) scroller.addEventListener(type, onUserScroll, { passive: true });
    window.addEventListener("keydown", onUserScroll);
    update();
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      scroller.removeEventListener("scroll", onScroll);
      for (const type of userEvents) scroller.removeEventListener(type, onUserScroll);
      window.removeEventListener("keydown", onUserScroll);
    };
  }, [items]);

  const groups = items.reduce<Record<string, NavItem[]>>((acc, item) => {
    (acc[item.group] ??= []).push(item);
    return acc;
  }, {});

  return (
    // Named so the landmark list can tell this in-page section list from the
    // tab bar's `nav` (settings-tab-nav.tsx), which is also a navigation.
    <nav aria-label={t("settings.nav.ariaLabel")} className="space-y-5">
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
                onClick={() => { clickedRef.current = id; setActiveId(id); }}
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
