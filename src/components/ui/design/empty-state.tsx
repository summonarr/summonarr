import Link from "next/link";
import type { IconComponent } from "@/components/icons";
import type { ComponentType, SVGProps } from "react";
import { cn } from "@/lib/utils";

type IconLike =
  | IconComponent
  | ComponentType<SVGProps<SVGSVGElement>>
  | React.ReactNode;

function isComponent(icon: IconLike): icon is ComponentType<SVGProps<SVGSVGElement>> {
  return typeof icon === "function";
}

// `cta` and `action` fill the same slot, so the type allows one or the other:
// passing both used to drop `action` silently, and is now a compile error.
type EmptyStateFooter =
  | {
      /** Renders a minimal accent-colored link below the description. */
      cta?: { href: string; label: string };
      action?: never;
    }
  | {
      cta?: never;
      /** Legacy slot for arbitrary actions (buttons, links, etc.). */
      action?: React.ReactNode;
    };

type EmptyStateProps = {
  icon?: IconLike;
  /** Optional — when omitted the description renders on its own. */
  title?: React.ReactNode;
  /** Friendly copy under the title. Preferred over `subtitle`. */
  description?: React.ReactNode;
  /** Legacy slot — rendered identically to `description`. */
  subtitle?: React.ReactNode;
  className?: string;
} & EmptyStateFooter;

function EmptyStateIcon({ icon }: { icon: IconLike }) {
  if (isComponent(icon)) {
    const Icon = icon;
    return (
      <Icon
        width={28}
        height={28}
        style={{
          color: "var(--ds-fg-subtle)",
          marginBottom: 12,
        }}
      />
    );
  }
  return (
    <div
      className="inline-flex"
      style={{
        padding: 12,
        borderRadius: 999,
        background: "var(--ds-bg-3)",
        color: "var(--ds-fg-subtle)",
        marginBottom: 12,
      }}
    >
      {icon as React.ReactNode}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  subtitle,
  cta,
  action,
  className,
}: EmptyStateProps) {
  const desc = description ?? subtitle;

  return (
    <div
      className={cn("text-center", className)}
      style={{
        background: "var(--ds-bg-1)",
        border: "1px dashed var(--ds-border)",
        borderRadius: "var(--ds-r-lg)",
        padding: "40px 20px",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
      }}
    >
      {icon && <EmptyStateIcon icon={icon} />}
      {title && (
        <div
          className="font-semibold"
          style={{
            fontSize: 14,
            marginBottom: 4,
            color: "var(--ds-fg-muted)",
          }}
        >
          {title}
        </div>
      )}
      {desc && (
        <div
          style={{
            fontSize: 13,
            color: "var(--ds-fg-subtle)",
            maxWidth: 360,
            lineHeight: 1.5,
          }}
        >
          {desc}
        </div>
      )}
      {cta && (
        <div style={{ marginTop: 14 }}>
          <Link
            href={cta.href}
            className="hover:underline"
            style={{
              fontSize: 13,
              color: "var(--ds-accent-text)",
              fontWeight: 500,
            }}
          >
            {cta.label}
          </Link>
        </div>
      )}
      {action && <div style={{ marginTop: 14 }}>{action}</div>}
    </div>
  );
}
