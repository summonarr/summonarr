import { RefreshCw, Wrench } from "@/components/icons";
import { StatePage } from "@/components/layout/state-page";

// Shown by (app)/layout.tsx INSTEAD of the whole app for non-admins while
// maintenance mode is on. It is a Server Component (no "use client") because
// nothing here is interactive. "Try again" is a plain <a> with an empty href,
// which points at the current URL: clicking it fully reloads the page, which
// re-runs the layout's maintenance check.
export function MaintenancePage({ message }: { message?: string }) {
  return (
    <StatePage
      frame="document"
      glyph={<Wrench style={{ width: 56, height: 56, color: "var(--ds-warning)" }} />}
      title="Under maintenance"
      description={message || "We're performing some maintenance. Please check back shortly."}
      secondary={[
        { label: "Try again", href: "", hard: true, icon: <RefreshCw className="w-4 h-4" /> },
      ]}
    />
  );
}
