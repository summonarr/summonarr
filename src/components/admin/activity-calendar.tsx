"use client";

// GitHub-style 365-day heatmap; data comes from getActivityCalendarUncached() in play-history.ts

const DOW_LABELS = ["", "Mon", "", "Wed", "", "Fri", ""];

interface CalendarData {
  day: string;
  count: number;
}

// `today` arrives as an ISO date string from the server page so SSR and
// hydration agree on the 365-day window. DO NOT replace with `new Date()`
// in render — module/render-level Date.now() is the canonical React #418
// hydration source (server's day vs client's day can disagree across
// timezones and second-of-the-day rollovers).
export function ActivityCalendar({ data, today: todayIso }: { data: CalendarData[]; today: string }) {
  const countMap = new Map(data.map((d) => [d.day, d.count]));
  const max = Math.max(...data.map((d) => d.count), 1);

  const today = new Date(todayIso);
  const days: { date: string; dow: number }[] = [];
  for (let i = 364; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    days.push({
      date: d.toISOString().split("T")[0],
      dow: d.getDay(),
    });
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
      const month = new Date(firstDay.date).getMonth();
      if (month !== lastMonth) {
        monthLabels.push({
          label: new Date(firstDay.date).toLocaleString("en-US", { month: "short" }),
          weekIndex: wi,
        });
        lastMonth = month;
      }
    }
  });

  return (
    <div className="overflow-x-auto">
      <div className="min-w-[700px]">
        <div className="flex ml-8 mb-1 gap-0.5">
          {weeks.map((_, wi) => {
            const ml = monthLabels.find((m) => m.weekIndex === wi);
            return (
              <div key={wi} className="w-3 text-[9px] text-zinc-600 shrink-0">
                {ml?.label ?? ""}
              </div>
            );
          })}
        </div>

        <div className="flex gap-1">
          <div className="flex flex-col gap-0.5 shrink-0 w-7">
            {DOW_LABELS.map((label, i) => (
              <div key={i} className="h-3 text-[9px] text-zinc-600 flex items-center justify-end pr-1">
                {label}
              </div>
            ))}
          </div>

          <div className="flex gap-0.5">
            {weeks.map((week, wi) => (
              <div key={wi} className="flex flex-col gap-0.5">
                {wi === 0 &&
                  Array.from({ length: week[0]?.dow ?? 0 }, (_, i) => (
                    <div key={`empty-${i}`} className="w-3 h-3" />
                  ))}
                {week.map((day) => {
                  const intensity = day.count / max;
                  return (
                    <div
                      key={day.date}
                      className="w-3 h-3 rounded-sm"
                      style={{
                        backgroundColor:
                          day.count === 0
                            ? "rgb(39, 39, 42)"
                            : `rgba(99, 102, 241, ${0.25 + intensity * 0.75})`,
                      }}
                      title={`${day.date}: ${day.count} plays`}
                    />
                  );
                })}
              </div>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-1 mt-2 ml-8">
          <span className="text-[9px] text-zinc-600">Less</span>
          {[0, 0.25, 0.5, 0.75, 1].map((level) => (
            <div
              key={level}
              className="w-3 h-3 rounded-sm"
              style={{
                backgroundColor:
                  level === 0
                    ? "rgb(39, 39, 42)"
                    : `rgba(99, 102, 241, ${0.25 + level * 0.75})`,
              }}
            />
          ))}
          <span className="text-[9px] text-zinc-600">More</span>
        </div>
      </div>
    </div>
  );
}
