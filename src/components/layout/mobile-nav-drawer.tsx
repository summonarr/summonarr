"use client";

import { useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession, signOut } from "next-auth/react";
import { LogOut, Bell } from "lucide-react";
import { cn } from "@/lib/utils";
import { userNavItems, getVisibleAdminItems } from "@/lib/nav-items";
import { PushNotifications } from "@/components/layout/push-notifications";
import {
  Drawer,
  DrawerPortal,
  DrawerBackdrop,
  DrawerPopup,
  DrawerContent,
  DrawerTitle,
} from "@/components/ui/drawer";

interface MobileNavDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function MobileNavDrawer({ open, onOpenChange }: MobileNavDrawerProps) {
  const pathname = usePathname();
  const { data: session } = useSession();
  const role = session?.user?.role;
  const adminItems = getVisibleAdminItems(role);

  const browseItems = userNavItems.filter((i) => i.section === "browse");
  const personalItems = userNavItems.filter((i) => i.section === "personal");

  useEffect(() => {
    onOpenChange(false);
  }, [pathname, onOpenChange]);

  function isActive(href: string, exact?: boolean) {
    return exact ? pathname === href : pathname.startsWith(href);
  }

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerPortal>
        <DrawerBackdrop />
        <DrawerPopup>
          <DrawerTitle>Navigation menu</DrawerTitle>
          <DrawerContent>
            <SectionHeader>Browse</SectionHeader>
            {browseItems.map((item) => (
              <NavLink
                key={item.href}
                href={item.href}
                label={item.label}
                icon={item.icon}
                active={isActive(item.href, item.exact)}
                onClick={() => onOpenChange(false)}
              />
            ))}

            <SectionHeader>My Stuff</SectionHeader>
            {personalItems.map((item) => (
              <NavLink
                key={item.href}
                href={item.href}
                label={item.label}
                icon={item.icon}
                active={isActive(item.href, item.exact)}
                onClick={() => onOpenChange(false)}
              />
            ))}

            {adminItems.length > 0 && (
              <>
                <SectionHeader>Admin</SectionHeader>
                {adminItems.map((item) => (
                  <NavLink
                    key={item.href}
                    href={item.href}
                    label={item.label}
                    icon={item.icon}
                    active={isActive(item.href, item.exact)}
                    onClick={() => onOpenChange(false)}
                  />
                ))}
              </>
            )}

            <div className="mt-4 pt-4 border-t border-zinc-800 space-y-1">
              <div className="flex items-center gap-3 px-4 py-3">
                <Bell className="w-5 h-5 shrink-0 text-zinc-400" />
                <span className="text-sm font-medium text-zinc-300 flex-1">Push Notifications</span>
                <PushNotifications />
              </div>
              <button
                onClick={() => signOut({ callbackUrl: "/login" })}
                className="flex items-center gap-3 w-full px-4 py-3 rounded-lg text-sm font-medium text-red-400 hover:bg-zinc-800/50 transition-colors"
              >
                <LogOut className="w-5 h-5" />
                Sign Out
              </button>
            </div>

            {}
            <div className="h-20" aria-hidden="true" />
          </DrawerContent>
        </DrawerPopup>
      </DrawerPortal>
    </Drawer>
  );
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-4 pt-4 pb-1 text-xs font-semibold text-zinc-500 uppercase tracking-wider">
      {children}
    </p>
  );
}

function NavLink({
  href,
  label,
  icon: Icon,
  active,
  onClick,
}: {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <Link
      href={href}
      onClick={onClick}
      className={cn(
        "flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-colors",
        active
          ? "text-indigo-400 bg-zinc-800/50"
          : "text-zinc-300 hover:text-white hover:bg-zinc-800/50"
      )}
    >
      <Icon className={cn("w-5 h-5 shrink-0", active && "text-indigo-400")} />
      {label}
    </Link>
  );
}
