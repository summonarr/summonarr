"use client";

import { useHasMounted } from "@/hooks/use-has-mounted";
import { useLocale } from "@/components/i18n/i18n-provider";

// Formats a date in the UI language and the VIEWER's timezone. Renders nothing until
// hydration so server and client never disagree (guardrail 16); server pages
// (admin/issues) use it instead of a server-side toLocaleDateString(), which
// would format in the container's locale/timezone.
export function LocalDateText({ iso }: { iso: string }) {
  const mounted = useHasMounted();
  const locale = useLocale();
  return <>{mounted ? new Date(iso).toLocaleDateString(locale) : ""}</>;
}
