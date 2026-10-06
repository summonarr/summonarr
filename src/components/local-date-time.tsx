"use client";

import { useHasMounted } from "@/hooks/use-has-mounted";
import { useLocale } from "@/components/i18n/i18n-provider";

// Date-AND-time twin of LocalDateText (local-date.tsx): formats an instant in
// the UI language and the VIEWER's timezone. Renders nothing until hydration so
// server and client never disagree (guardrail 16). Server pages use it instead
// of a server-side toLocaleString(), which formats in the container's timezone
// and shows a wrong wall-clock time to anyone not in that zone.
export function LocalDateTime({ iso }: { iso: string }) {
  const mounted = useHasMounted();
  const locale = useLocale();
  return <time dateTime={iso}>{mounted ? new Date(iso).toLocaleString(locale) : ""}</time>;
}
