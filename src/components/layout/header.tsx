"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronRight } from "@/components/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { useSummonarrSession } from "@/components/auth/summonarr-session-provider";
import { PushNotifications } from "@/components/layout/push-notifications";
import { NotificationBell } from "@/components/layout/notification-bell";
import { signOutAndRedirect } from "@/components/auth/sign-out";
import { avatarInitials } from "@/lib/avatar-initials";
import { breadcrumbFor } from "@/components/layout/breadcrumb-label";
import { useT } from "@/components/i18n/i18n-provider";
import { useDetailTitle } from "@/components/layout/detail-title";
import { AppearanceMenu } from "@/components/theme/appearance-menu";
import { getClientBadgeVisibility } from "@/lib/badge-visibility";
import { SearchBar } from "./search-bar";
import { visibleAdminNavItems } from "./nav-visibility";

// Desktop top bar: breadcrumb, search, push toggle, and the account dropdown.
export function Header({ featureFlags }: { featureFlags?: Record<string, boolean> } = {}) {
  const t = useT();
  const pathname = usePathname();
  const { session } = useSummonarrSession();
  // Show "Settings" only to users who can actually open /settings (anyone else
  // is redirected away). We ask the shared nav resolver instead of checking
  // for ADMIN here, so this stays in step with the page's own gate.
  const canOpenSettings = visibleAdminNavItems(session?.user, featureFlags).some((i) => i.href === "/settings");
  // Same Plex/Jellyfin badge rule as MobileNav and the server pages. It keys
  // on the user's `mediaServer`, not the sign-in `provider` — the two differ
  // for a local-password or OIDC account.
  const { showPlex, showJellyfin } = getClientBadgeVisibility(session?.user);
  // The session carries no avatar image (it is kept slim): the avatar is the
  // user's initials.
  const initials = avatarInitials(session?.user?.name);

  const detailTitle = useDetailTitle();
  const crumbs = breadcrumbFor(pathname, detailTitle, t);

  return (
    <header
      className="hidden lg:flex items-center sticky top-0 z-30"
      style={{
        gap: 14,
        padding: "10px 18px",
        height: 52,
        borderBottom: "1px solid var(--ds-border)",
        background: "color-mix(in oklab, var(--ds-bg) 85%, transparent)",
        backdropFilter: "blur(10px)",
      }}
    >
      {/* Breadcrumb */}
      <nav aria-label={t("nav.breadcrumb")} className="min-w-0">
        <ol className="flex items-center min-w-0 m-0 p-0 list-none" style={{ gap: 6 }}>
          {crumbs.map((c, i) => {
            const last = i === crumbs.length - 1;
            const content = (
              <span
                aria-current={last ? "page" : undefined}
                style={{
                  fontSize: 13,
                  fontWeight: last ? 500 : 400,
                  // A linked crumb inherits from its <Link>, which owns the
                  // muted base AND the hover colour; an inline colour here
                  // would beat the Link's hover and the crumb would never react.
                  color: last ? "var(--ds-fg)" : c.href ? undefined : "var(--ds-fg-muted)",
                }}
              >
                {c.label}
              </span>
            );
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: crumbs are positional
              <li key={i} className="flex items-center min-w-0" style={{ gap: 6 }}>
                {i > 0 && (
                  <ChevronRight
                    aria-hidden
                    style={{
                      width: 12,
                      height: 12,
                      color: "var(--ds-fg-subtle)",
                    }}
                  />
                )}
                {c.href && !last ? (
                  <Link
                    href={c.href}
                    className="text-[var(--ds-fg-muted)] hover:text-[var(--ds-fg)] transition-colors"
                  >
                    {content}
                  </Link>
                ) : (
                  content
                )}
              </li>
            );
          })}
        </ol>
      </nav>

      {/* Search */}
      <div className="flex-1 min-w-0 flex justify-center">
        <SearchBar showPlex={showPlex} showJellyfin={showJellyfin} />
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1.5">
        {session && <NotificationBell />}
        {session && <PushNotifications />}

        <DropdownMenu>
          {/* 36px hit box around a 28px avatar — the visual stays small, the
              target clears the 32–36px minimum the other header controls use. */}
          <DropdownMenuTrigger
            aria-label={t("nav.accountMenu")}
            // ds-hover-tint gives this the same hover feedback as the bells
            // beside it — the three header controls used to react unevenly.
            className="ds-hover-tint inline-flex items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-accent-ring)]"
            style={{ width: 36, height: 36 }}
          >
            <Avatar
              style={{
                width: 28,
                height: 28,
                border: "1px solid var(--ds-border)",
              }}
            >
              <AvatarFallback
                className="font-semibold"
                style={{
                  fontSize: 11,
                  background: "var(--ds-bg-3)",
                  color: "var(--ds-fg)",
                }}
              >
                {initials}
              </AvatarFallback>
            </Avatar>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <div
              className="truncate min-w-0"
              title={session?.user?.name ?? session?.user?.email ?? undefined}
              style={{
                padding: "6px 8px",
                fontSize: 13,
                fontWeight: 500,
                color: "var(--ds-fg)",
              }}
            >
              {session?.user?.name ?? session?.user?.email}
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem render={<Link href="/profile" />}>
              {t("nav.profile")}
            </DropdownMenuItem>
            {canOpenSettings && (
              <DropdownMenuItem render={<Link href="/settings" />}>
                {t("nav.settings")}
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <AppearanceMenu />
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onClick={() => signOutAndRedirect("/login")}
            >
              {t("nav.signOut")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
