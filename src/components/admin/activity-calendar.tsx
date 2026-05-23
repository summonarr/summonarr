"use client";

// GitHub-style 365-day heatmap; data comes from getActivityCalendarUncached()
// in play-history.ts. Restyled to the Claude Design "Activity Page" handoff:
// DS-token indigo wash, 11px cells, mono gutter labels, Less→More legend.

const DOW_LABELS = ["", "Mon", "", "Wed", "", "Fri", ""];
const CELL = 11;
const GAP = 2;

interface CalendarData {
  day: string;
  count: number;
}

function cellBg(count: number, max: number): string {
  if (count === 0) return "oklch(1 0 0 / 0.025)";
  const intensity = max > 0 ? count / max : 0;
  return `oklch(0.58 0.21 275 / ${(0.12 + intensity * 0.76).toFixed(3)})`;
}

// `today` arrives as an ISO date string from the server page so SSR and
// hydration agree on the 365-day window. DO NOT replace with `new Date()`
// in render — module/render-level Date.now() is the canonical React #418
// hydration source (server's day vs client's day can disagree across
// timezones and second-of-the-day rollovers).
export function ActivityCalendar({
  data,
  today: todayIso,
}: {
  data: CalendarData[];
  today: string;
}) {
  const countMap = new Map(data.map((d) => [d.day, d.count]));
  const max = Math.max(...data.map((d) => d.count), 1);
  const totalPlays = data.reduce((sum, d) => sum + d.count, 0);
  const activeDays = data.filter((d) => d.count > 0).length;

  const today = new Date(todayIso);
  const days: { date: string; dow: number }[] = [];
  for (let i = 364; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    days.push({ date: d.toISOString().split("T")[0], dow: d.getUTCDay() });
  }

  const weeks: { date: string; dow: number; count: number }[][] = [];
  let currentWeek: { date: string; dow: number; count: number }[] = [];
  for (const day of days) {
    if (day.dow === 0 && currentWeek.length > 0) {
      weeks.push(currentWeek);
      currentWeek = [];
    }
    currentWeek.push({ ...day, count: countMap.get(day.date) ?? 0 });
  }
  if (currentWeek.length > 0) weeks.push(currentWeek);

  const monthLabels: { label: string; weekIndex: number }[] = [];
  let lastMonth = -1;
  weeks.forEach((week, wi) => {
    const firstDay = week[0];
    if (firstDay) {
      const month = new Date(firstDay.date).getUTCMonth();
      if (month !== lastMonth) {
        monthLabels.push({
          label: new Date(firstDay.date).toLocaleString("en-US", {
            month: "short",
            timeZone: "UTC",
          }),
          weekIndex: wi,
        });
        lastMonth = month;
      }
    }
  });

  return (
    <div>
      <p
        className="sm:hidden ds-mono"
        style={{
          fontSize: 10.5,
          color: "var(--ds-fg-disabled)",
          marginBottom: 6,
          userSelect: "none",
        }}
      >
        ← swipe to see the full year →
      </p>
      <div className="overflow-x-auto">
        <div
          role="img"
          aria-label={`Activity over the last 365 days. ${totalPlays.toLocaleString()} total plays across ${activeDays} active days. Peak day: ${max} plays.`}
          style={{ minWidth: 700 }}
        >
          {/* Month labels */}
          <div style={{ display: "flex", marginLeft: 26, marginBottom: 6, gap: GAP }}>
            {weeks.map((_, wi) => {
              const ml = monthLabels.find((m) => m.weekIndex === wi);
              return (
                <div
                  key={wi}
                  className="ds-mono"
                  style={{
                    width: CELL,
                    fontSize: 9.5,
                    color: "var(--ds-fg-disabled)",
                    flexShrink: 0,
                    whiteSpace: "nowrap",
                  }}
                >
                  {ml?.label ?? ""}
                </div>
              );
            })}
          </div>

          <div style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
            {/* Day-of-week gutter */}
            <div
              style={{ display: "flex", flexDirection: "column", gap: GAP }}
            >
              {DOW_LABELS.map((label, i) => (
                <div
                  key={i}
                  className="ds-mono"
                  style={{
                    height: CELL,
                    lineHeight: `${CELL}px`,
                    fontSize: 9.5,
                    color: "var(--ds-fg-disabled)",
                    textAlign: "right",
                    width: 20,
                  }}
                >
                  {label}
                </div>
              ))}
            </div>

            {/* Cells */}
            <div style={{ display: "flex", gap: GAP }}>
              {weeks.map((week, wi) => (
                <div
                  key={wi}
                  style={{ display: "flex", flexDirection: "column", gap: GAP }}
                >
                  {wi === 0 &&
                    Array.from({ length: week[0]?.dow ?? 0 }, (_, i) => (
                      <div
                        key={`empty-${i}`}
                        style={{ width: CELL, height: CELL }}
                      />
                    ))}
                  {week.map((day) => (
                    <div
                      key={day.date}
                      title={`${day.date}: ${day.count} plays`}
                      style={{
                        width: CELL,
                        height: CELL,
                        borderRadius: 2,
                        background: cellBg(day.count, max),
                      }}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>

          {/* Legend */}
          <div
            className="ds-mono"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              marginTop: 10,
              marginLeft: 26,
              fontSize: 10,
              color: "var(--ds-fg-disabled)",
            }}
          >
            <span>Less</span>
            {[0, 0.25, 0.5, 0.75, 1].map((level) => (
              <div
                key={level}
                style={{
                  width: CELL,
                  height: CELL,
                  borderRadius: 2,
                  background: cellBg(level === 0 ? 0 : level * max, max),
                }}
              />
            ))}
            <span>More</span>
          </div>
        </div>
      </div>
    </div>
  );
}
