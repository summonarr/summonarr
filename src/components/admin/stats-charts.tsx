"use client";

interface MonthData {
  month: string;
  count: number;
}

export function StatsCharts({ data }: { data: MonthData[] }) {
  const max = Math.max(...data.map((d) => d.count), 1);

  return (
    <div className="flex items-end gap-2 h-40">
      {data.map((d) => {
        const height = (d.count / max) * 100;
        const label = d.month.slice(5);
        const year = d.month.slice(0, 4);
        return (
          <div key={d.month} className="flex-1 flex flex-col items-center gap-1 min-w-0">
            <span className="text-xs text-zinc-500 tabular-nums">{d.count}</span>
            <div className="w-full flex items-end justify-center" style={{ height: "100px" }}>
              <div
                className="w-full max-w-[32px] bg-indigo-600 rounded-t transition-all hover:bg-indigo-500"
                style={{ height: `${Math.max(height, 2)}%` }}
                title={`${d.month}: ${d.count} requests`}
              />
            </div>
            <span className="text-[10px] text-zinc-600 tabular-nums">{label}</span>
            {label === "01" && (
              <span className="text-[9px] text-zinc-700 -mt-0.5">{year}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}
