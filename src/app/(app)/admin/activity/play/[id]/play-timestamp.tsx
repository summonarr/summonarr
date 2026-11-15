"use client";

// Started / Stopped cells for the play detail page, rendered the way the
// history table renders the same row: in the statistics time zone the page
// passes (guardrail 19g), tagged with that zone, once the page has hydrated.
// Until `useHasMounted` flips it renders a UTC-pinned, UTC-labelled string —
// the same text on the server and on the browser's first paint (guardrail 16)
// — and swaps in the zone's time afterwards. Without this the table said
// "Oct 5, 9:30 PM" and this page said another time for one play.

import { useHasMounted } from "@/hooks/use-has-mounted";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import { fmtTimestamp, ZoneTag } from "@/components/admin/activity-ui";

export function PlayTimestamp({ iso, timeZone }: { iso: string | null; timeZone: string }) {
  const mounted = useHasMounted();
  const locale = useLocale();
  const t = useT();
  if (!iso) return <>—</>;
  if (!mounted) {
    return (
      <>
        {`${new Date(iso).toLocaleString(locale, {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
          timeZone: "UTC",
        })} UTC`}
      </>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      {fmtTimestamp(iso, mounted, locale, timeZone)}
      <ZoneTag zone={timeZone} title={t("adminActivity.play.zoneTimesTitle", { zone: timeZone })} />
    </span>
  );
}
