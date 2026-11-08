// The bordered, sideways-scrolling table the admin report pages share (Missing,
// Never watched): one head row, then the body rows. Hook-free and no "use
// client", so a client or a server component can render it.
import type { ReactNode } from "react";

export function ReportTable({ head, children }: { head: ReactNode; children: ReactNode }) {
  return (
    <div className="resp-table-scroll" style={{ border: "1px solid var(--ds-border)", borderRadius: 10 }}>
      <table className="w-full" style={{ fontSize: 13, borderCollapse: "collapse", color: "var(--ds-fg)" }}>
        <thead>
          <tr style={{ background: "var(--ds-bg-2)", textAlign: "left", color: "var(--ds-fg-subtle)", fontSize: 11 }}>{head}</tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
