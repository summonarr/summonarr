import Link from "next/link";
import type { IconComponent } from "@/components/icons";
import type { ComponentType, SVGProps } from "react";

type IconLike =
  | IconComponent
  | ComponentType<SVGProps<SVGSVGElement>>
  | React.ReactNode;

function isComponent(icon: IconLike): icon is ComponentType<SVGProps<SVGSVGElement>> {
  return typeof icon === "function";
}

export function EmptyState({
  icon,
  title,
  description,
  subtitle,
  cta,
  action,
}: {
  icon?: IconLike;
  title: React.ReactNode;
  /** Friendly copy under the title. Preferred over `subtitle`. */
  description?: React.ReactNode;
  /** Legacy slot — rendered identically to `description`. */
  subtitle?: React.ReactNode;
  /** Renders a minimal accent-colored link below the description. */
  cta?: { href: string; label: string };
  /** Legacy slot for arbitrary actions (buttons, links, etc.). */
  action?: React.ReactNode;
}) {
  const desc = description ?? subtitle;

  return (
    <div
      className="text-center"
      style={{
        background: "var(--ds-bg-1)",
        border: "1px dashed var(--ds-border)",
        borderRadius: 10,
        padding: "40px 20px",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
      }}
    >
      {icon &&
        (isComponent(icon) ? (
          (() => {
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
          })()
        ) : (
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
        ))}
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
            style={{
              fontSize: 13,
              color: "var(--ds-accent)",
              fontWeight: 500,
            }}
          >
            {cta.label}
          </Link>
        </div>
      )}
      {action && !cta && <div style={{ marginTop: 14 }}>{action}</div>}
    </div>
  );
}
