// The unread-count pill on the notification controls: the desktop header bell
// (md) and the mobile top bar's inbox link (sm). One copy so the two keep the
// same cap and look. Decorative (aria-hidden): each control carries the count
// in its own accessible name.
const SIZES = {
  sm: { box: 14, radius: 7, font: 9 },
  md: { box: 15, radius: 8, font: 9.5 },
} as const;

export function UnreadCountBadge({ count, size }: { count: number; size: keyof typeof SIZES }) {
  if (count <= 0) return null;
  const s = SIZES[size];
  return (
    <span
      aria-hidden
      style={{
        position: "absolute",
        top: 2,
        right: 2,
        minWidth: s.box,
        height: s.box,
        padding: "0 3px",
        borderRadius: s.radius,
        background: "var(--ds-accent)",
        color: "var(--ds-accent-fg)",
        fontSize: s.font,
        fontWeight: 700,
        lineHeight: `${s.box}px`,
        textAlign: "center",
        boxSizing: "border-box",
      }}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}
