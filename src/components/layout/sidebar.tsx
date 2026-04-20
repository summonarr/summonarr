"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession } from "next-auth/react";
import { cn } from "@/lib/utils";
import { Film } from "lucide-react";
import { userNavItems, getVisibleAdminItems } from "@/lib/nav-items";

export function Sidebar({ siteTitle }: { siteTitle?: string }) {
  const pathname = usePathname();
  const { data: session } = useSession();
  const role = session?.user?.role;

  const visibleAdminItems = getVisibleAdminItems(role);

  return (
    <aside className="hidden md:flex flex-col w-56 shrink-0 bg-zinc-900 border-r border-zinc-800 h-screen sticky top-0">
      <div className="flex items-center gap-2 px-5 py-5 border-b border-zinc-800">
        <div className="w-8 h-8 rounded-md bg-indigo-600 flex items-center justify-center">
          <Film className="w-4 h-4 text-white" />
        </div>
        <span className="font-bold text-white text-lg tracking-tight">
          {siteTitle || "Summonarr"}
        </span>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-1">
        {userNavItems.map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            className={cn(
              "flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors",
              pathname === href
                ? "bg-indigo-600 text-white"
                : "text-zinc-400 hover:text-white hover:bg-zinc-800"
            )}
          >
            <Icon className="w-4 h-4 shrink-0" />
            {label}
          </Link>
        ))}

        {visibleAdminItems.length > 0 && (
          <>
            <div className="pt-4 pb-1">
              <p className="px-3 text-xs font-semibold text-zinc-600 uppercase tracking-wider">
                Admin
              </p>
            </div>
            {visibleAdminItems.map(({ href, label, icon: Icon, exact }) => (
              <Link
                key={href}
                href={href}
                className={cn(
                  "flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors",
                  (exact ? pathname === href : pathname.startsWith(href))
                    ? "bg-indigo-600 text-white"
                    : "text-zinc-400 hover:text-white hover:bg-zinc-800"
                )}
              >
                <Icon className="w-4 h-4 shrink-0" />
                {label}
              </Link>
            ))}
          </>
        )}
      </nav>
      <div className="px-4 py-3 border-t border-zinc-800 shrink-0">
        <a
          href="https://www.themoviedb.org"
          target="_blank"
          rel="noopener noreferrer"
          title="This product uses the TMDB API but is not endorsed or certified by TMDB."
          className="flex items-center gap-2 opacity-40 hover:opacity-70 transition-opacity"
        >
          {}
          <img
            src="/tmdb-logo.svg"
            alt="TMDB"
            className="h-4 w-auto"
          />
          <span className="text-[11px] text-zinc-500 leading-tight">Data provided by TMDB</span>
        </a>
      </div>
    </aside>
  );
}
