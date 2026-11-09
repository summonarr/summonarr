// The small count badge on a segment of a segmented control (FilterBar's
// buttons, the list filter pills), so the two can't drift apart.
export function SegmentCount({ isActive, children }: { isActive: boolean; children: React.ReactNode }) {
  return (
    <span
      className="ds-mono"
      style={{
        fontSize: 10,
        padding: "0 5px",
        borderRadius: 3,
        background: isActive ? "var(--ds-accent-soft)" : "var(--ds-bg-3)",
        color: isActive ? "var(--ds-accent-text)" : "var(--ds-fg-subtle)",
      }}
    >
      {children}
    </span>
  );
}
