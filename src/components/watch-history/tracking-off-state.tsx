import type { ComponentProps } from "react";
import { EmptyState } from "@/components/ui/design";
import type { Translator } from "@/lib/i18n/translate";

// Shared "play history tracking is off" state for the three personal watch
// pages (/watch-history, /my-stats, /my-stats/wrapped). Tracking defaults OFF
// (feature `playHistoryEnabled`), and while it is off nothing is recorded — so
// those pages' "plays will show up here" empty copy would be a lie. This is the
// /popular gate applied to the personal surfaces. Server component: each page
// hands over its own translator. The settings link renders only for a viewer
// who can actually open /settings (that page redirects anyone without the
// ADMIN bit), so a plain user is told what is off, not sent somewhere they
// bounce off.
export function TrackingOffState({
  icon,
  t,
  canOpenSettings,
}: {
  icon: ComponentProps<typeof EmptyState>["icon"];
  t: Translator;
  canOpenSettings: boolean;
}) {
  return (
    <EmptyState
      icon={icon}
      title={t("personal.common.trackingOff.title")}
      description={t("personal.common.trackingOff.description")}
      cta={
        canOpenSettings
          ? // The settings page is tabbed: the play-history card is on the Media
            // tab, so a bare "#play-history" would land on the Site tab and miss.
            { href: "/settings?tab=media#play-history", label: t("personal.common.trackingOff.cta") }
          : undefined
      }
    />
  );
}
