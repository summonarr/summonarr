"use client";

// Started / Stopped cells for the play detail page, rendered the way the
// history table renders the same row: in the viewer's own time zone, once the
// page has hydrated. The server knows only the container's zone, so until
// `useHasMounted` flips it renders a UTC-pinned, UTC-labelled string — the
// same text on the server and on the browser's first paint (guardrail 16) —
// and swaps in the local time afterwards. Without this the table said
// "Oct 5, 9:30 PM" and this page said "Oct 6, 2:30 AM UTC" for one play.

import { useHasMounted } from "@/hooks/use-has-mounted";
import { useLocale } from "@/components/i18n/i18n-provider";
import { fmtTimestamp } from "@/components/admin/activity-ui";

export function PlayTimestamp({ iso }: { iso: string | null }) {
  const mounted = useHasMounted();
  const locale = useLocale();
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
  return <>{fmtTimestamp(iso, mounted, locale)}</>;
}
