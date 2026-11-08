// The settings page's own server-rendered pieces, shared by every tab.
import type { ReactNode } from "react";
import type { Translator } from "@/lib/i18n/translate";

export function StatusBadge({ connected, t }: { connected: boolean; t: Translator }) {
  if (connected) {
    return (
      <span className="ds-chip ds-chip-approved">{t("settings.common.connected")}</span>
    );
  }
  return (
    <span className="ds-chip">{t("settings.common.notConfigured")}</span>
  );
}

// Every card on the page: one surface, one radius, one header recipe. The
// cards used to carry this inline and had drifted — descriptions were 14px
// subtle on some tabs and 12px muted on others, the badge row had its own
// margin, and one card had no header at all. `id` is what the side nav's
// `#hash` links and the scroll-spy target; `.settings-sections > [id]` in
// globals.css gives it the scroll margin.
export function SettingsCard({
  id,
  title,
  description,
  badge,
  children,
}: {
  id: string;
  title: ReactNode;
  description?: ReactNode;
  badge?: ReactNode;
  children: ReactNode;
}) {
  const heading = (
    <h2 className="font-semibold" style={{ fontSize: 15, letterSpacing: "-0.01em", color: "var(--ds-fg)", margin: 0 }}>
      {title}
    </h2>
  );
  return (
    <div
      id={id}
      style={{ padding: 22, background: "var(--ds-bg-2)", border: "1px solid var(--ds-border)", borderRadius: "var(--ds-r-lg)" }}
    >
      <div className="mb-5">
        {badge ? <div className="flex items-center gap-3">{heading}{badge}</div> : heading}
        {description && (
          <p style={{ fontSize: 12, color: "var(--ds-fg-muted)", margin: "4px 0 0", lineHeight: 1.5 }}>{description}</p>
        )}
      </div>
      {children}
    </div>
  );
}

/** A card title with the muted "(optional)" tag (the 4K instances). */
export function OptionalTitle({ name, t }: { name: string; t: Translator }) {
  return <>{`${name} `}<span style={{fontSize:12,color:"var(--ds-fg-subtle)",fontWeight:400}}>{t("settings.common.optional")}</span></>;
}

export type MetricItem = { label: string; value: ReactNode; dim?: boolean };

// One metric group's tiles. Values arrive formatted, so toLocaleString runs
// on the server in the page's locale; `dim` greys a value that means "nothing
// yet". The zinc utilities are retargeted to the theme tokens in globals.css
// (the legacy colour remap), so the tiles follow both themes.
export function MetricGrid({ items, className }: { items: MetricItem[]; className?: string }) {
  return (
    <div className={className ? `grid grid-cols-2 sm:grid-cols-4 gap-2 ${className}` : "grid grid-cols-2 sm:grid-cols-4 gap-2"}>
      {items.map(({ label, value, dim }) => (
        <div key={label} className="bg-zinc-800 border border-zinc-800 rounded-lg px-4 py-3">
          <p className="text-xs text-zinc-500 mb-1">{label}</p>
          <p className={`text-xl font-semibold tabular-nums ${dim ? "text-zinc-500" : "text-zinc-100"}`}>{value}</p>
        </div>
      ))}
    </div>
  );
}

/** A metric group's small uppercase heading. */
export function MetricHeading({ children, spaced = true }: { children: ReactNode; spaced?: boolean }) {
  return (
    <h3 className={spaced ? "text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-3" : "text-xs font-semibold uppercase tracking-wider text-zinc-500"}>
      {children}
    </h3>
  );
}
