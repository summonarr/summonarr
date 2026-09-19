import { RefreshCw, Wrench } from "@/components/icons";
import { StatePage } from "@/components/layout/state-page";

// Rendered by (app)/layout.tsx IN PLACE of the whole authenticated shell for
// non-admins while maintenance mode is on. Stays a Server Component: the
// layout is one, and there is nothing interactive here. "Try again" is a hard
// anchor with an empty href — that resolves to the document's own URL, so it
// reloads whichever page the gate replaced without this component having to
// know the pathname (and a full load, not a soft navigation, is what re-runs
// the layout's maintenance check from scratch).
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
