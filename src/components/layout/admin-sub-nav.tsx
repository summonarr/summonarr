"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { getVisibleAdminItems } from "@/lib/nav-items";

export function AdminSubNav({ role }: { role?: string }) {
  const pathname = usePathname();
  const items = getVisibleAdminItems(role);

  if (items.length === 0) return null;

  return (
    <nav
      role="navigation"
      aria-label="Admin pages"
      className="md:hidden -mx-6 -mt-6 lg:-mx-8 lg:-mt-8 xl:-mx-10 xl:-mt-10 mb-4 sticky top-[57px] z-20 flex gap-1.5 overflow-x-auto px-4 py-2.5 border-b border-zinc-800 bg-zinc-950/80 backdrop-blur [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]"
    >
      {items.map(({ href, label, exact }) => {
        const active = exact ? pathname === href : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "shrink-0 px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-colors",
              active
                ? "bg-indigo-600 text-white"
                : "bg-zinc-800 text-zinc-400 hover:text-white"
            )}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
