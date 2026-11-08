"use client";

// One row of a ranked title list (rank, poster, title, count), shared by the My
// Stats "most watched" card and the Wrapped top-titles list so the two can't
// drift. The two sizes differ only in the numbers below.
import type { CSSProperties, ReactNode } from "react";
import Link from "next/link";
import { Poster } from "@/components/admin/activity-ui";

type RowSize = {
  rowGap: number;
  rank: CSSProperties;
  /** "01" (zero-padded) or "1". */
  padRank: boolean;
  poster: { w: number; h: number; radius: number };
  innerGap: number;
  titleFontSize: number;
  /** Underline the title link on hover. */
  underline: boolean;
  countFontSize: number;
};

const SIZES: Record<"compact" | "large", RowSize> = {
  compact: {
    rowGap: 10,
    rank: { width: 16, textAlign: "right", fontSize: 10.5, color: "var(--ds-fg-disabled)" },
    padRank: true,
    poster: { w: 28, h: 40, radius: 3 },
    innerGap: 8,
    titleFontSize: 13,
    underline: false,
    countFontSize: 11,
  },
  large: {
    rowGap: 12,
    rank: { width: 20, textAlign: "right", fontSize: 15, fontWeight: 700, color: "var(--ds-accent-text)" },
    padRank: false,
    poster: { w: 32, h: 46, radius: 4 },
    innerGap: 10,
    titleFontSize: 14,
    underline: true,
    countFontSize: 12,
  },
};

const ELLIPSIS: CSSProperties = { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };

/** A title as a link when it has a detail page, else plain text, ellipsized
 *  either way. */
export function TitleLink({
  href,
  title,
  fontSize,
  underline,
}: {
  href: string | null;
  title: string;
  fontSize: number;
  underline: boolean;
}) {
  if (href) {
    return (
      <Link
        href={href}
        className={underline ? "hover:underline" : undefined}
        style={{ fontSize, color: "var(--ds-fg)", textDecoration: "none", ...ELLIPSIS }}
      >
        {title}
      </Link>
    );
  }
  return <span style={{ fontSize, color: "var(--ds-fg)", ...ELLIPSIS }}>{title}</span>;
}

export function RankedTitleRow({
  rank,
  title,
  href,
  posterSrc,
  count,
  size,
}: {
  /** 1-based. */
  rank: number;
  title: string;
  href: string | null;
  posterSrc: string | null;
  count: ReactNode;
  size: keyof typeof SIZES;
}) {
  const s = SIZES[size];
  return (
    <div style={{ display: "flex", alignItems: "center", gap: s.rowGap }}>
      <span className="ds-mono" style={s.rank}>
        {s.padRank ? rank.toString().padStart(2, "0") : rank}
      </span>
      <Poster src={posterSrc} letter={(title[0] ?? "?").toUpperCase()} w={s.poster.w} h={s.poster.h} radius={s.poster.radius} />
      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          gap: s.innerGap,
        }}
      >
        <TitleLink href={href} title={title} fontSize={s.titleFontSize} underline={s.underline} />
        <span
          className="ds-mono"
          style={{
            fontSize: s.countFontSize,
            color: "var(--ds-fg-subtle)",
            fontVariantNumeric: "tabular-nums",
            flexShrink: 0,
          }}
        >
          {count}
        </span>
      </div>
    </div>
  );
}
