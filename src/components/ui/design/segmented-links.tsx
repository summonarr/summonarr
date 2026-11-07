import Link from "next/link";

export type SegmentedLink = {
  key: string;
  label: React.ReactNode;
  href: string;
};

// The design-system FilterBar's segmented control, for segments that are LINKS
// (a server page whose state lives in the URL) rather than buttons. Same track
// and the same raised active segment: a bg-3 fill alone was ~1.07:1 against
// the bg-1 track in light mode, so the active segment also carries a
// border-strong ring and a small shadow, visible in both themes.
export function SegmentedLinks({
  links,
  active,
}: {
  links: readonly SegmentedLink[];
  active: string;
}) {
  return (
    <div
      className="ds-no-scrollbar flex overflow-x-auto max-w-full"
      style={{
        padding: 2,
        background: "var(--ds-bg-1)",
        border: "1px solid var(--ds-border)",
        borderRadius: 8,
      }}
    >
      {links.map((l) => {
        const isActive = l.key === active;
        return (
          <Link
            key={l.key}
            href={l.href}
            aria-current={isActive ? "page" : undefined}
            className="ds-hover-tint inline-flex items-center whitespace-nowrap shrink-0 font-medium"
            style={{
              // 32px hit area: on a page whose only controls these are, 5px
              // padding alone left them ~26px tall at phone width.
              minHeight: 32,
              padding: "5px 12px",
              borderRadius: 6,
              fontSize: 12,
              background: isActive ? "var(--ds-bg-2)" : "transparent",
              // Inactive segments leave box-shadow unset so .ds-hover-tint's
              // inset tint (a box-shadow) still shows on hover.
              boxShadow: isActive
                ? "var(--ds-shadow-sm), inset 0 0 0 1px var(--ds-border-strong)"
                : undefined,
              color: isActive ? "var(--ds-fg)" : "var(--ds-fg-muted)",
              transition: "all 120ms var(--ds-ease)",
            }}
          >
            {l.label}
          </Link>
        );
      })}
    </div>
  );
}
