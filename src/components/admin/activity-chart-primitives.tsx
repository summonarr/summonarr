"use client";

export function BarChart({
  data,
  labelKey,
  valueKey,
  color = "bg-indigo-600 hover:bg-indigo-500",
  formatValue,
}: {
  data: { [k: string]: unknown }[];
  labelKey: string;
  valueKey: string;
  color?: string;
  formatValue?: (v: number) => string;
}) {
  if (data.length === 0) return <p className="text-zinc-500 text-sm">No data</p>;
  const max = Math.max(...data.map((d) => Number(d[valueKey]) || 0), 1);

  return (
    <div className="flex items-end gap-1.5 h-32">
      {data.map((d, i) => {
        const val = Number(d[valueKey]) || 0;
        const height = (val / max) * 100;
        const label = String(d[labelKey] ?? "");
        const displayVal = formatValue ? formatValue(val) : String(val);
        return (
          <div key={`${label}-${i}`} className="flex-1 flex flex-col items-center gap-0.5 min-w-0">
            <span className="text-[10px] text-zinc-500 tabular-nums">{displayVal}</span>
            <div className="w-full flex items-end justify-center" style={{ height: "80px" }}>
              <div
                className={`w-full max-w-[24px] rounded-t transition-all ${color}`}
                style={{ height: `${Math.max(height, 2)}%` }}
                title={`${label}: ${displayVal}`}
              />
            </div>
            <span className="text-[9px] text-zinc-600 tabular-nums truncate max-w-full">
              {label.slice(-5)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function HorizontalBar({
  items,
  max,
  color = "bg-indigo-600",
}: {
  items: { label: string; value: number; sub?: string }[];
  max: number;
  color?: string;
}) {
  return (
    <div className="space-y-2">
      {items.map((item, i) => (
        <div key={`${item.label}-${i}`} className="flex items-center gap-3">
          <span className="text-zinc-600 w-5 text-right text-xs">{i + 1}.</span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between text-sm mb-0.5">
              <span className="text-white truncate">{item.label}</span>
              <span className="text-zinc-400 tabular-nums shrink-0 ml-2">{item.value}</span>
            </div>
            <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full ${color}`}
                style={{ width: `${max > 0 ? (item.value / max) * 100 : 0}%` }}
              />
            </div>
            {item.sub && <span className="text-[10px] text-zinc-600">{item.sub}</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

const DOW_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function HeatmapChart({ data }: { data: { dow: number; hour: number; count: number }[] }) {
  const grid: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
  data.forEach((d) => {
    if (d.dow >= 0 && d.dow < 7 && d.hour >= 0 && d.hour < 24) {
      grid[d.dow][d.hour] = d.count;
    }
  });
  const max = Math.max(...data.map((d) => d.count), 1);

  return (
    <div className="overflow-x-auto">
      <div className="min-w-[400px]">
        <div className="flex ml-10 mb-1">
          {Array.from({ length: 24 }, (_, h) => (
            <div key={h} className="flex-1 text-center text-[8px] text-zinc-600 tabular-nums">
              {h % 3 === 0 ? h : ""}
            </div>
          ))}
        </div>
        {grid.map((row, dow) => (
          <div key={dow} className="flex items-center gap-1 mb-0.5">
            <span className="text-[10px] text-zinc-500 w-9 text-right shrink-0">
              {DOW_LABELS[dow]}
            </span>
            <div className="flex flex-1 gap-0.5">
              {row.map((count, hour) => {
                const intensity = count / max;
                return (
                  <div
                    key={hour}
                    className="flex-1 aspect-square rounded-sm"
                    style={{
                      backgroundColor:
                        count === 0
                          ? "rgb(39, 39, 42)"
                          : `rgba(99, 102, 241, ${0.2 + intensity * 0.8})`,
                    }}
                    title={`${DOW_LABELS[dow]} ${String(hour).padStart(2, "0")}:00 — ${count} plays`}
                  />
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function MediaTypeBar({ data }: { data: { type: string; count: number }[] }) {
  const total = data.reduce((s, d) => s + d.count, 0);
  if (total === 0) return <p className="text-zinc-500 text-sm">No data</p>;

  return (
    <div className="space-y-3">
      {data.map((d) => {
        const pct = Math.round((d.count / total) * 100);
        const color = d.type === "MOVIE" ? "bg-blue-500" : "bg-purple-500";
        const label = d.type === "MOVIE" ? "Movies" : "TV Shows";
        return (
          <div key={d.type}>
            <div className="flex justify-between text-sm mb-1">
              <span className="text-zinc-300">{label}</span>
              <span className="text-zinc-400 tabular-nums">
                {d.count} ({pct}%)
              </span>
            </div>
            <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
              <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function CompletionHistogram({ data }: { data: { bucket: string; count: number }[] }) {
  const bucketOrder = ["0-25%", "25-50%", "50-75%", "75-100%"];
  const ordered = bucketOrder.map((b) => ({
    bucket: b,
    count: data.find((d) => d.bucket === b)?.count ?? 0,
  }));
  const max = Math.max(...ordered.map((d) => d.count), 1);

  return (
    <div className="space-y-2">
      {ordered.map((d) => {
        const pct = max > 0 ? (d.count / max) * 100 : 0;
        const color =
          d.bucket === "75-100%"
            ? "bg-green-500"
            : d.bucket === "50-75%"
              ? "bg-blue-500"
              : d.bucket === "25-50%"
                ? "bg-yellow-500"
                : "bg-red-500";
        return (
          <div key={d.bucket}>
            <div className="flex justify-between text-xs mb-0.5">
              <span className="text-zinc-400">{d.bucket}</span>
              <span className="text-zinc-500 tabular-nums">{d.count}</span>
            </div>
            <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
              <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function DistributionBars({
  items,
  colorFor,
  formatValue,
}: {
  items: { label: string; value: number }[];
  colorFor?: (label: string, i: number) => string;
  formatValue?: (value: number, pct: number) => string;
}) {
  const total = items.reduce((s, r) => s + r.value, 0);
  if (total === 0) return <p className="text-zinc-500 text-sm">No data</p>;
  const palette = [
    "bg-indigo-500",
    "bg-emerald-500",
    "bg-amber-500",
    "bg-rose-500",
    "bg-cyan-500",
    "bg-fuchsia-500",
    "bg-lime-500",
    "bg-sky-500",
  ];
  return (
    <div className="space-y-2.5">
      {items.map((r, i) => {
        const pct = total > 0 ? Math.round((r.value / total) * 100) : 0;
        const color = colorFor ? colorFor(r.label, i) : palette[i % palette.length];
        const display = formatValue
          ? formatValue(r.value, pct)
          : `${r.value.toLocaleString()} (${pct}%)`;
        return (
          <div key={`${r.label}-${i}`}>
            <div className="flex justify-between text-xs mb-1">
              <span className="text-zinc-300 truncate">{r.label}</span>
              <span className="text-zinc-500 tabular-nums shrink-0 ml-2">{display}</span>
            </div>
            <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
              <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.max(pct, 2)}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function StatTile({
  label,
  value,
  sub,
  delta,
}: {
  label: string;
  value: string;
  sub?: string;
  delta?: { pct: number; good?: "up" | "down" } | null;
}) {
  const deltaColor = !delta
    ? ""
    : delta.pct === 0
      ? "text-zinc-500"
      : (delta.good === "up" ? delta.pct > 0 : delta.pct < 0)
        ? "text-emerald-400"
        : "text-rose-400";
  const deltaArrow = !delta ? "" : delta.pct > 0 ? "▲" : delta.pct < 0 ? "▼" : "—";
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
      <p className="text-xs text-zinc-500 uppercase tracking-wide mb-1">{label}</p>
      <p className="text-2xl font-bold text-white tabular-nums">{value}</p>
      {sub && <p className="text-xs text-zinc-500 mt-0.5">{sub}</p>}
      {delta && (
        <p className={`text-[11px] mt-1 tabular-nums ${deltaColor}`}>
          {deltaArrow} {Math.abs(delta.pct)}% vs prev
        </p>
      )}
    </div>
  );
}

export function TranscodeRatioBars({ data }: { data: { method: string; count: number }[] }) {
  const total = data.reduce((s, r) => s + r.count, 0);
  if (total === 0) return <p className="text-zinc-500 text-sm">No data</p>;
  return (
    <div className="space-y-3">
      {data.map((r) => {
        const pct = total > 0 ? Math.round((r.count / total) * 100) : 0;
        const color =
          r.method === "Transcode"
            ? "bg-orange-500"
            : r.method === "DirectPlay"
              ? "bg-green-500"
              : "bg-blue-500";
        const label =
          r.method === "DirectPlay" ? "Direct Play" : r.method === "DirectStream" ? "Direct Stream" : r.method;
        return (
          <div key={r.method}>
            <div className="flex justify-between text-sm mb-1">
              <span className="text-zinc-300">{label}</span>
              <span className="text-zinc-400 tabular-nums">
                {r.count} ({pct}%)
              </span>
            </div>
            <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
              <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
