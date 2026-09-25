"use client";

import { useHasMounted } from "@/hooks/use-has-mounted";

// Formats a date in the VIEWER's locale and timezone. Renders nothing until
// hydration so server and client never disagree (guardrail 16); server pages
// (admin/issues) use it instead of a server-side toLocaleDateString(), which
// would format in the container's locale/timezone.
export function LocalDateText({ iso }: { iso: string }) {
  const mounted = useHasMounted();
  return <>{mounted ? new Date(iso).toLocaleDateString() : ""}</>;
}
