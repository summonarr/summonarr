import { cn } from "@/lib/utils";

// Shared in-page section heading: title, optional mono subtitle under it, and an
// optional right-aligned slot (a "See all" link, a "1–36 of 200" range label).
// One definition for the discover rails, /popular and /top, which carried three
// byte-identical copies. No hooks, so server and client components can both
// render it.
export function SectionHeader({
  title,
  subtitle,
  right,
  className,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  right?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-end gap-3", className)} style={{ marginBottom: 12 }}>
      <div className="min-w-0">
        <h2
          className="m-0 font-semibold"
          style={{ fontSize: 15, letterSpacing: "-0.01em", color: "var(--ds-fg)" }}
        >
          {title}
        </h2>
        {subtitle && (
          <p
            className="ds-mono m-0"
            style={{ fontSize: 11, color: "var(--ds-fg-subtle)", marginTop: 2 }}
          >
            {subtitle}
          </p>
        )}
      </div>
      {right && <div className="ml-auto flex items-center shrink-0">{right}</div>}
    </div>
  );
}
