import Link from "next/link";
import type { IconComponent } from "@/components/icons";
import { isValidElement, type ComponentType, type SVGProps } from "react";
import { cn } from "@/lib/utils";

type IconLike =
  | IconComponent
  | ComponentType<SVGProps<SVGSVGElement>>
  | React.ReactNode;

// A plain function component, or a memo()/forwardRef() one — those are objects
// carrying $$typeof, and unlike an element they can't be rendered as a child.
function isComponent(icon: IconLike): icon is ComponentType<SVGProps<SVGSVGElement>> {
  if (typeof icon === "function") return true;
  return typeof icon === "object" && icon !== null && "$$typeof" in icon && !isValidElement(icon);
}

/** Whether a node slot has something to show. Unlike a truthiness check, a
 *  numeric 0 is content, not "nothing". */
function hasContent(node: unknown): boolean {
  return node !== null && node !== undefined && node !== false && node !== true && node !== "";
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
  /** Friendly copy under the title. */
  description?: React.ReactNode;
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
  cta,
  action,
  className,
}: EmptyStateProps) {
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
      {hasContent(icon) && <EmptyStateIcon icon={icon} />}
      {hasContent(title) && (
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
      {hasContent(description) && (
        <div
          style={{
            fontSize: 13,
            color: "var(--ds-fg-subtle)",
            maxWidth: 360,
            lineHeight: 1.5,
          }}
        >
          {description}
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
      {hasContent(action) && <div style={{ marginTop: 14 }}>{action}</div>}
    </div>
  );
}
