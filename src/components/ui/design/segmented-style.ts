// The segmented control's look, shared by FilterBar (button segments) and
// SegmentedLinks (link segments) so the two can't drift apart.

/** The track the segments sit in. */
export const SEGMENTED_TRACK_STYLE: React.CSSProperties = {
  padding: 2,
  background: "var(--ds-bg-1)",
  border: "1px solid var(--ds-border)",
  borderRadius: 8,
};

/** One segment's colours, raised when active. A bg-3 fill alone was ~1.07:1
 *  against the bg-1 track in light mode — the selected segment was nearly
 *  invisible — so the active one also carries a border-strong edge and a small
 *  shadow, visible in both themes. Inactive segments leave box-shadow unset so
 *  .ds-hover-tint's inset tint (a box-shadow) can show on hover; an inline
 *  "none" beat the class rule and the segments had no hover state. */
export function segmentedItemStyle(isActive: boolean): React.CSSProperties {
  return {
    padding: "5px 12px",
    borderRadius: 6,
    fontSize: 12,
    background: isActive ? "var(--ds-bg-2)" : "transparent",
    boxShadow: isActive ? "var(--ds-shadow-sm), inset 0 0 0 1px var(--ds-border-strong)" : undefined,
    color: isActive ? "var(--ds-fg)" : "var(--ds-fg-muted)",
    transition: "all 120ms var(--ds-ease)",
  };
}
