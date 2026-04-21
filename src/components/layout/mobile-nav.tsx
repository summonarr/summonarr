"use client";

import { useState, useCallback } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession } from "next-auth/react";
import { cn } from "@/lib/utils";
import { MoreHorizontal, ShieldCheck, AlertTriangle } from "lucide-react";
import { userNavItems, filterNavByFeatures } from "@/lib/nav-items";
import type { FeatureFlags } from "@/lib/features";
import { MobileNavDrawer } from "@/components/layout/mobile-nav-drawer";

const adminItem = { href: "/admin", label: "Admin", icon: ShieldCheck, exact: true };
const issueAdminItem = { href: "/admin/issues", label: "Issues", icon: AlertTriangle, exact: false };

export function MobileNav({ featureFlags }: { featureFlags?: FeatureFlags }) {
  const pathname = usePathname();
  const { data: session } = useSession();
  const role = session?.user?.role;
  const [drawerOpen, setDrawerOpen] = useState(false);
  const handleOpenChange = useCallback((open: boolean) => setDrawerOpen(open), []);

  const bottomBarItems = filterNavByFeatures(
    userNavItems.filter((i) => i.mobileBottomBar),
    featureFlags,
  );

  const roleItem =
    role === "ADMIN" ? adminItem : role === "ISSUE_ADMIN" ? issueAdminItem : null;

  const bottomBarHrefs = bottomBarItems.map((i) => i.href);
  if (roleItem) bottomBarHrefs.push(roleItem.href);

  const isOnBottomBarPage = bottomBarHrefs.some((href, idx) => {
    const item = bottomBarItems[idx] ?? roleItem;
    return item?.exact ? pathname === href : pathname.startsWith(href);
  });
  const moreActive = drawerOpen || !isOnBottomBarPage;

  return (
    <>
      <nav className="md:hidden fixed bottom-0 inset-x-0 z-40 bg-zinc-900 border-t border-zinc-800 flex pb-[env(safe-area-inset-bottom)]">
        {bottomBarItems.map(({ href, label, icon: Icon, exact }) => {
          const active = exact ? pathname === href : pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex-1 flex flex-col items-center gap-1 py-2.5 text-[10px] font-medium transition-colors",
                active ? "text-indigo-400" : "text-zinc-500 hover:text-zinc-300"
              )}
            >
              <Icon className={cn("w-5 h-5", active && "text-indigo-400")} />
              {label}
            </Link>
          );
        })}

        {roleItem && (
          <Link
            href={roleItem.href}
            className={cn(
              "flex-1 flex flex-col items-center gap-1 py-2.5 text-[10px] font-medium transition-colors",
              (roleItem.exact ? pathname === roleItem.href : pathname.startsWith(roleItem.href))
                ? "text-indigo-400"
                : "text-zinc-500 hover:text-zinc-300"
            )}
          >
            <roleItem.icon
              className={cn(
                "w-5 h-5",
                (roleItem.exact ? pathname === roleItem.href : pathname.startsWith(roleItem.href)) &&
                  "text-indigo-400"
              )}
            />
            {roleItem.label}
          </Link>
        )}

        <button
          onClick={() => setDrawerOpen(true)}
          aria-expanded={drawerOpen}
          aria-haspopup="dialog"
          className={cn(
            "flex-1 flex flex-col items-center gap-1 py-2.5 text-[10px] font-medium transition-colors",
            moreActive ? "text-indigo-400" : "text-zinc-500 hover:text-zinc-300"
          )}
        >
          <MoreHorizontal className={cn("w-5 h-5", moreActive && "text-indigo-400")} />
          More
        </button>
      </nav>

      <MobileNavDrawer open={drawerOpen} onOpenChange={handleOpenChange} featureFlags={featureFlags} />
    </>
  );
}
