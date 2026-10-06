// Presentation pieces for /admin/stats. Server components only — no hooks and
// no clock reads (guardrail 16): every date they show arrives as a fixed
// string and is formatted in UTC, so the markup is the same wherever it renders.
import Link from "next/link";

export const STATUS_COLOR = {
  PENDING: "var(--ds-warning)",
  APPROVED: "var(--ds-accent)",
  AVAILABLE: "var(--ds-success)",
  DECLINED: "var(--ds-danger)",
} as const;

export const MEDIA_COLOR = {
  MOVIE: "var(--ds-accent)",
  TV: "var(--ds-info)",
} as const;

export function StatsSection({
  title,
  subtitle,
  right,
  children,
  id,
}: {
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  right?: React.ReactNode;
  children: React.ReactNode;
  id?: string;
}) {
  return (
    <section
      aria-labelledby={id && title ? `${id}-title` : undefined}
      style={{
        padding: 20,
        background: "var(--ds-bg-2)",
        border: "1px solid var(--ds-border)",
        borderRadius: 8,
        marginBottom: 20,
      }}
    >
      {(title || right) && (
        <div className="flex items-start gap-3 flex-wrap" style={{ marginBottom: 14 }}>
          <div className="min-w-0">
            {title && (
              <h2
                id={id ? `${id}-title` : undefined}
                className="font-semibold"
                style={{ fontSize: 15, letterSpacing: "-0.01em", color: "var(--ds-fg)", margin: 0 }}
              >
                {title}
              </h2>
            )}
            {subtitle && (
              <p className="ds-mono" style={{ fontSize: 11, color: "var(--ds-fg-subtle)", margin: "2px 0 0" }}>
                {subtitle}
              </p>
            )}
          </div>
          {right && <div className="ml-auto flex items-center shrink-0">{right}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function SubHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3
      className="ds-mono uppercase"
      style={{ fontSize: 10.5, color: "var(--ds-fg-subtle)", letterSpacing: "0.08em", margin: "0 0 10px" }}
    >
      {children}
    </h3>
  );
}

// A grid of label/value pairs — the in-section equivalent of StatCard.
export function MetricGrid({
  items,
  columns = "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4",
}: {
  items: Array<{ label: React.ReactNode; value: React.ReactNode; hint?: React.ReactNode; tone?: "warning" | "danger" | "success" }>;
  columns?: string;
}) {
  return (
    <dl className={`grid ${columns}`} style={{ gap: 14, margin: 0 }}>
      {items.map((m, i) => (
        // dt precedes dd in the DOM, as a <dl> requires; column-reverse draws
        // the value on top, and justify-end pins it to the top edge so a label
        // that wraps to two lines doesn't push its value below its neighbours'.
        <div key={i} className="min-w-0 flex flex-col-reverse justify-end">
          <dt
            className="ds-mono uppercase"
            style={{ fontSize: 10, color: "var(--ds-fg-subtle)", letterSpacing: "0.06em", margin: "2px 0 0" }}
          >
            {m.label}
            {m.hint && (
              <span className="normal-case" style={{ display: "block", letterSpacing: 0, marginTop: 2 }}>
                {m.hint}
              </span>
            )}
          </dt>
          <dd
            className="font-semibold ds-mono"
            style={{
              fontSize: 18,
              margin: 0,
              letterSpacing: "-0.02em",
              fontVariantNumeric: "tabular-nums",
              // The status tokens are tuned as text on every surface
              // (guardrail 42), so they double as text colours here.
              color:
                m.tone === "danger" ? "var(--ds-danger)"
                : m.tone === "warning" ? "var(--ds-warning)"
                : m.tone === "success" ? "var(--ds-success)"
                : "var(--ds-fg)",
            }}
          >
            {m.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

// One horizontal bar split into coloured shares, with a legend underneath.
export function ShareBar({
  parts,
  formatNumber,
  ariaLabel,
}: {
  parts: Array<{ label: string; value: number; color: string }>;
  formatNumber: (n: number) => string;
  ariaLabel: string;
}) {
  const total = parts.reduce((s, p) => s + p.value, 0);
  const pct = (v: number) => (total > 0 ? (v / total) * 100 : 0);
  return (
    <div>
      <div
        role="img"
        aria-label={`${ariaLabel}: ${parts.map((p) => `${p.label} ${formatNumber(p.value)}`).join(", ")}`}
        className="flex overflow-hidden"
        style={{ height: 10, borderRadius: 999, background: "var(--ds-bg-3)" }}
      >
        {parts.map((p) =>
          p.value > 0 ? (
            <div key={p.label} style={{ width: `${pct(p.value)}%`, background: p.color }} title={`${p.label}: ${formatNumber(p.value)}`} />
          ) : null,
        )}
      </div>
      <ul className="flex flex-wrap" style={{ gap: "6px 16px", margin: "10px 0 0", padding: 0, listStyle: "none" }}>
        {parts.map((p) => (
          <li key={p.label} className="flex items-center" style={{ gap: 6, fontSize: 12, color: "var(--ds-fg-muted)" }}>
            <span aria-hidden style={{ width: 8, height: 8, borderRadius: 2, background: p.color, flexShrink: 0 }} />
            <span style={{ color: "var(--ds-fg)" }}>{p.label}</span>
            <span className="ds-mono" style={{ fontVariantNumeric: "tabular-nums" }}>
              {formatNumber(p.value)}
              {total > 0 && ` · ${Math.round(pct(p.value))}%`}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Ranked list: label (optionally linked) + right-aligned value + optional
// muted detail line.
export function RankList({
  rows,
  emptyLabel,
}: {
  rows: Array<{ key: string; label: React.ReactNode; href?: string; value: React.ReactNode; detail?: React.ReactNode }>;
  emptyLabel: string;
}) {
  if (rows.length === 0) {
    return <p style={{ fontSize: 13, color: "var(--ds-fg-subtle)", margin: 0 }}>{emptyLabel}</p>;
  }
  return (
    <ol className="flex flex-col" style={{ gap: 8, margin: 0, padding: 0, listStyle: "none" }}>
      {rows.map((r, i) => (
        <li key={r.key} className="flex items-start justify-between" style={{ fontSize: 13, gap: 12 }}>
          <div className="flex items-start min-w-0" style={{ gap: 10 }}>
            <span
              className="ds-mono text-right shrink-0"
              style={{ width: 20, color: "var(--ds-fg-subtle)", fontSize: 11, paddingTop: 2 }}
            >
              {i + 1}.
            </span>
            <div className="min-w-0">
              {r.href ? (
                <Link href={r.href} className="block truncate hover:underline" style={{ color: "var(--ds-fg)" }}>
                  {r.label}
                </Link>
              ) : (
                <span className="block truncate" style={{ color: "var(--ds-fg)" }}>{r.label}</span>
              )}
              {r.detail && (
                <span className="block ds-mono" style={{ fontSize: 10.5, color: "var(--ds-fg-subtle)", marginTop: 2 }}>
                  {r.detail}
                </span>
              )}
            </div>
          </div>
          <span className="ds-mono shrink-0" style={{ color: "var(--ds-fg-muted)", fontVariantNumeric: "tabular-nums" }}>
            {r.value}
          </span>
        </li>
      ))}
    </ol>
  );
}

// Usage meter (disk space). `pct` is 0–100 and already clamped by the caller.
export function Meter({
  label,
  detail,
  pct,
  valueText,
  sub,
}: {
  label: string;
  detail: string;
  pct: number;
  valueText: string;
  sub?: React.ReactNode;
}) {
  const color = pct > 90 ? "var(--ds-danger)" : pct > 75 ? "var(--ds-warning)" : "var(--ds-accent)";
  return (
    <div style={{ marginBottom: 12 }}>
      <div className="flex justify-between" style={{ fontSize: 12, marginBottom: 4, gap: 12 }}>
        <span className="truncate" style={{ color: "var(--ds-fg)" }} title={label}>{label}</span>
        <span className="ds-mono shrink-0" style={{ color: "var(--ds-fg-muted)" }}>{detail}</span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
        aria-valuetext={valueText}
        className="overflow-hidden"
        style={{ height: 6, background: "var(--ds-bg-3)", borderRadius: 999 }}
      >
        <div className="h-full" style={{ width: `${pct}%`, background: color, borderRadius: 999 }} />
      </div>
      {sub && (
        <div className="ds-mono" style={{ fontSize: 10.5, color: "var(--ds-fg-subtle)", marginTop: 4 }}>{sub}</div>
      )}
    </div>
  );
}

// Stacked monthly columns. `months` are "YYYY-MM" (UTC); labels come out in the
// viewer's language. The current month is still filling up, so it is drawn
// faded with a dashed outline and marked, instead of reading as a sudden drop. A hidden
// table carries the same numbers for screen readers.
export function MonthChart({
  months,
  series,
  locale,
  currentMonth,
  ariaLabel,
  partialLabel,
  monthHeader,
  formatNumber,
  height = 120,
}: {
  months: string[];
  series: Array<{ key: string; label: string; color: string; values: number[] }>;
  locale: string;
  currentMonth: string;
  ariaLabel: string;
  partialLabel: string;
  monthHeader: string;
  formatNumber: (n: number) => string;
  height?: number;
}) {
  const totals = months.map((_, i) => series.reduce((s, x) => s + (x.values[i] ?? 0), 0));
  const max = Math.max(1, ...totals);
  const monthFmt = new Intl.DateTimeFormat(locale, { month: "short", timeZone: "UTC" });
  // Twelve columns on a phone leave ~25px each — "Sep" no longer fits.
  const narrowFmt = new Intl.DateTimeFormat(locale, { month: "narrow", timeZone: "UTC" });
  const longFmt = new Intl.DateTimeFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" });
  const date = (m: string) => new Date(`${m}-01T00:00:00Z`);

  return (
    <figure style={{ margin: 0 }}>
      {/* height + room for the count above and the month + year lines below
          (~14 + 14 + 11 px plus the gaps); less let the counts climb into the
          heading above the chart. */}
      <div aria-hidden className="flex items-end" style={{ gap: 6, height: height + 60 }}>
        {months.map((m, i) => {
          const partial = m === currentMonth;
          const showYear = i === 0 || m.endsWith("-01");
          const tip = `${longFmt.format(date(m))}${partial ? ` (${partialLabel})` : ""}: ${series
            .map((s) => `${s.label} ${formatNumber(s.values[i] ?? 0)}`)
            .join(", ")}`;
          return (
            <div key={m} className="flex-1 flex flex-col items-center min-w-0" style={{ gap: 3 }} title={tip}>
              <span className="ds-mono" style={{ fontSize: 10.5, color: "var(--ds-fg-subtle)", fontVariantNumeric: "tabular-nums" }}>
                {formatNumber(totals[i])}
              </span>
              <div className="w-full flex items-end justify-center" style={{ height }}>
                <div
                  className="w-full flex flex-col-reverse overflow-hidden"
                  style={{
                    maxWidth: 32,
                    height: `${Math.max((totals[i] / max) * 100, totals[i] > 0 ? 2 : 1)}%`,
                    borderRadius: "3px 3px 0 0",
                    opacity: partial ? 0.55 : 1,
                    background: totals[i] > 0 ? undefined : "var(--ds-bg-3)",
                    outline: partial ? "1px dashed var(--ds-border-strong)" : undefined,
                  }}
                >
                  {series.map((s) =>
                    (s.values[i] ?? 0) > 0 ? (
                      <div key={s.key} style={{ height: `${((s.values[i] ?? 0) / Math.max(totals[i], 1)) * 100}%`, background: s.color }} />
                    ) : null,
                  )}
                </div>
              </div>
              <span className="ds-mono truncate" style={{ fontSize: 10, color: "var(--ds-fg-muted)", maxWidth: "100%" }}>
                <span className="sm:hidden">{narrowFmt.format(date(m))}</span>
                <span className="hidden sm:inline">{monthFmt.format(date(m))}</span>
              </span>
              <span className="ds-mono" style={{ fontSize: 9, color: "var(--ds-fg-subtle)", minHeight: 11 }}>
                {showYear ? m.slice(0, 4) : ""}
              </span>
            </div>
          );
        })}
      </div>
      {series.length > 1 && (
        <figcaption>
          <ul className="flex flex-wrap" aria-hidden style={{ gap: "6px 16px", margin: "8px 0 0", padding: 0, listStyle: "none" }}>
            {series.map((s) => (
              <li key={s.key} className="flex items-center" style={{ gap: 6, fontSize: 12, color: "var(--ds-fg-muted)" }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: s.color }} />
                {s.label}
              </li>
            ))}
          </ul>
        </figcaption>
      )}
      <table className="sr-only">
        <caption>{ariaLabel}</caption>
        <thead>
          <tr>
            <th scope="col">{monthHeader}</th>
            {series.map((s) => <th key={s.key} scope="col">{s.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {months.map((m, i) => (
            <tr key={m}>
              <th scope="row">{longFmt.format(date(m))}{m === currentMonth ? ` (${partialLabel})` : ""}</th>
              {series.map((s) => <td key={s.key}>{formatNumber(s.values[i] ?? 0)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

// Small inline notice (an unreachable instance, a caveat on a figure).
export function StatsNote({ children, tone = "muted" }: { children: React.ReactNode; tone?: "muted" | "warning" }) {
  return (
    <p
      style={{ fontSize: 12, color: tone === "warning" ? "var(--ds-warning)" : "var(--ds-fg-subtle)", margin: "8px 0 0" }}
    >
      {children}
    </p>
  );
}
