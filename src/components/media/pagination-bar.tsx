"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ChevronLeft, ChevronRight } from "@/components/icons";

interface PaginationBarProps {
  currentPage: number;
  totalPages: number;
}

export function PaginationBar({ currentPage, totalPages }: PaginationBarProps) {
  const searchParams = useSearchParams();

  function buildHref(page: number) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("page", String(page));
    return `?${params.toString()}`;
  }

  if (totalPages <= 1) return null;

  const hasPrev = currentPage > 1;
  const hasNext = currentPage < totalPages;

  const pages: number[] = [];
  const start = Math.max(1, currentPage - 2);
  const end = Math.min(totalPages, currentPage + 2);
  for (let i = start; i <= end; i++) pages.push(i);

  // Below `sm` the full ±2 window (plus first/last jumps and two ellipses)
  // is ~358px — wider than a 375px phone's content box. Narrow it to ±1 there
  // with CSS, not a width read (render must match SSR). A neighbour adjacent
  // to page 1 / the last page stays, or the row would skip a number with no
  // ellipsis to say so.
  const hideOnMobile = (p: number) =>
    Math.abs(p - currentPage) === 2 &&
    p > 2 &&
    p < totalPages - 1;

  return (
    <div
      className="flex flex-wrap items-center justify-center mt-8"
      style={{ gap: 4 }}
    >
      <PagerButton href={hasPrev ? buildHref(currentPage - 1) : undefined} ariaLabel="Previous page">
        <ChevronLeft style={{ width: 14, height: 14 }} />
      </PagerButton>

      {start > 1 && (
        <>
          <PagerButton href={buildHref(1)}>1</PagerButton>
          {start > 2 && (
            <span
              className="ds-mono"
              style={{
                padding: "0 4px",
                fontSize: 12,
                color: "var(--ds-fg-subtle)",
              }}
            >
              …
            </span>
          )}
        </>
      )}

      {pages.map((p) =>
        p === currentPage ? (
          <PagerButton key={p} active>
            {p}
          </PagerButton>
        ) : (
          <PagerButton
            key={p}
            href={buildHref(p)}
            className={hideOnMobile(p) ? "max-sm:hidden" : undefined}
          >
            {p}
          </PagerButton>
        ),
      )}

      {end < totalPages && (
        <>
          {end < totalPages - 1 && (
            <span
              className="ds-mono"
              style={{
                padding: "0 4px",
                fontSize: 12,
                color: "var(--ds-fg-subtle)",
              }}
            >
              …
            </span>
          )}
          <PagerButton href={buildHref(totalPages)}>{totalPages}</PagerButton>
        </>
      )}

      <PagerButton href={hasNext ? buildHref(currentPage + 1) : undefined} ariaLabel="Next page">
        <ChevronRight style={{ width: 14, height: 14 }} />
      </PagerButton>
    </div>
  );
}

function PagerButton({
  href,
  active,
  children,
  ariaLabel,
  className: extraClassName,
}: {
  className?: string;
  href?: string;
  active?: boolean;
  children: React.ReactNode;
  ariaLabel?: string;
}) {
  const disabled = !href && !active;
  const style: React.CSSProperties = {
    width: 32,
    height: 32,
    borderRadius: 6,
    border: `1px solid ${active ? "transparent" : "var(--ds-border)"}`,
    background: active
      ? "var(--ds-accent)"
      : disabled
        ? "transparent"
        : "var(--ds-bg-2)",
    color: active
      ? "var(--ds-accent-fg)"
      : disabled
        ? "var(--ds-fg-disabled)"
        : "var(--ds-fg-muted)",
    fontSize: 12,
    fontWeight: 500,
    transition: "all 120ms var(--ds-ease)",
  };
  const className = `inline-flex items-center justify-center font-medium${
    extraClassName ? ` ${extraClassName}` : ""
  }`;

  if (href) {
    // Only the navigable variant gets hover feedback — the active page and the
    // disabled ends are inert spans.
    return (
      <Link href={href} className={`${className} ds-hover-tint`} style={style} aria-label={ariaLabel}>
        {children}
      </Link>
    );
  }
  return (
    <span
      className={className}
      style={style}
      aria-label={ariaLabel}
      aria-current={active ? "page" : undefined}
      aria-disabled={disabled ? "true" : undefined}
    >
      {children}
    </span>
  );
}
