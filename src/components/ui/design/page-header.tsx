import { cn } from "@/lib/utils";

export function PageHeader({
  title,
  subtitle,
  right,
  kbd,
  className,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  right?: React.ReactNode;
  kbd?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("ds-page-header mb-5", className)}>
      <div className="flex-1 min-w-0">
        <h1
          className="m-0 flex items-center gap-2.5 font-semibold"
          style={{
            fontSize: 22,
            letterSpacing: "-0.02em",
            color: "var(--ds-fg)",
          }}
        >
          {title}
          {kbd && <kbd className="ds-kbd" style={{ fontSize: 10 }}>{kbd}</kbd>}
        </h1>
        {subtitle && (
          <p
            className="ds-mono m-0 mt-1"
            style={{ color: "var(--ds-fg-subtle)", fontSize: 12 }}
          >
            {subtitle}
          </p>
        )}
      </div>
      {right && (
        <div className="ds-page-header-actions flex gap-1.5 flex-wrap">
          {right}
        </div>
      )}
    </div>
  );
}
