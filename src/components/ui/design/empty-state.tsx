export function EmptyState({
  icon,
  title,
  subtitle,
  action,
}: {
  icon?: React.ReactNode;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div
      className="text-center"
      style={{
        background: "var(--ds-bg-1)",
        border: "1px dashed var(--ds-border)",
        borderRadius: 8,
        padding: "40px 20px",
      }}
    >
      {icon && (
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
          {icon}
        </div>
      )}
      <div
        className="font-medium"
        style={{ fontSize: 14, marginBottom: 4, color: "var(--ds-fg)" }}
      >
        {title}
      </div>
      {subtitle && (
        <div
          className="ds-mono"
          style={{ fontSize: 11, color: "var(--ds-fg-subtle)" }}
        >
          {subtitle}
        </div>
      )}
      {action && <div style={{ marginTop: 14 }}>{action}</div>}
    </div>
  );
}
