// The 365-day activity calendar's grid (src/components/admin/activity-calendar-grid.ts):
// the day window, the Sunday-first columns, the totals, and where an arrow key
// moves the roving focus.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCalendarModel,
  calendarKeyTarget,
  cellBg,
  horizontalTarget,
  nearestActive,
} from "../src/components/admin/activity-calendar-grid.ts";

// The statistics zone's today at UTC midnight, as the server page sends it.
const TODAY = "2026-11-07T00:00:00.000Z";

test("the window is the 365 days ending on the server's today, in Sunday-first columns", () => {
  const m = buildCalendarModel([], TODAY, "en", true);
  assert.equal(m.days.length, 365);
  assert.equal(m.days[364].date, "2026-11-07");
  assert.equal(m.days[0].date, "2025-11-08");
  assert.equal(m.weeks[0].length, 7 - m.days[0].dow, "the first column starts on the first day's weekday");
  assert.ok(m.weeks.slice(1, -1).every((w) => w.length === 7 && w[0].dow === 0));
  assert.equal(m.max, 1, "an empty calendar floors the colour scale at 1");
  assert.equal(m.peak, 0);
});

test("counts, totals and the clickable days come from the data", () => {
  const data = [
    { day: "2026-11-07", count: 4 },
    { day: "2026-11-01", count: 9 },
    { day: "2026-10-31", count: 0 },
    { day: "2020-01-01", count: 2 },
  ];
  const m = buildCalendarModel(data, TODAY, "en", true);
  assert.equal(m.peak, 9);
  assert.equal(m.totalPlays, 15);
  assert.equal(m.activeDays, 3);
  assert.deepEqual(m.activeIdx.map((i) => m.days[i].date), ["2026-11-01", "2026-11-07"], "days outside the window are not cells");
  assert.deepEqual(buildCalendarModel(data, TODAY, "en", false).activeIdx, [], "a static calendar has nothing to focus");
});

test("two month labels never sit closer than three columns", () => {
  const m = buildCalendarModel([], TODAY, "en", false);
  for (let i = 1; i < m.monthLabels.length; i++) {
    assert.ok(m.monthLabels[i].weekIndex - m.monthLabels[i - 1].weekIndex >= 3);
  }
  assert.equal(m.monthLabels.at(-1)?.label, "Nov");
});

test("the colour ramp has a floor for any play and a faint tint for none", () => {
  assert.match(cellBg(0, 10), /var\(--ds-fg\) 7%/);
  assert.match(cellBg(1, 40), /var\(--ds-accent\) 31\.5%/);
  assert.match(cellBg(40, 40), /var\(--ds-accent\) 90\.0%/);
});

// Indexes with no leading blanks (firstDow 0): column = floor(i / 7), row = i % 7.
test("ArrowLeft/ArrowRight move a week, to the same weekday, not one row up or down", () => {
  // From Wednesday of week 2 (index 17). The cell one row up (16) is closer by
  // raw index than the same weekday two weeks back (3).
  const active = [3, 16, 17];
  assert.equal(horizontalTarget(active, 17, -1, 0), 3);
  assert.equal(nearestActive(active, 17, 17 - 7, -1), 16, "the raw-index rule this replaces took the cell above");
});

test("a horizontal move takes the nearest column with an active day, then the nearest weekday in it", () => {
  // From index 10 (column 1, row 3). Column 2 holds rows 0 and 4; row 4 is
  // nearer, though row 0 comes first; column 3 is never reached.
  assert.equal(horizontalTarget([14, 18, 24], 10, 1, 0), 18);
  // An equally near weekday above and below: the upper one.
  assert.equal(horizontalTarget([15, 17], 9, 1, 0), 15);
  assert.equal(horizontalTarget([1, 2], 10, 1, 0), null, "nothing further right: the edge");
  // Leading blanks shift the columns: with firstDow 6, index 0 is column 0 and index 1 column 1.
  assert.equal(horizontalTarget([0, 1], 0, 1, 6), 1);
});

test("the key map: up/down by index, Home/End to the ends, other keys untouched", () => {
  const model = { activeIdx: [2, 9, 30], days: [{ dow: 0 }] as { dow: number }[] } as Parameters<typeof calendarKeyTarget>[1];
  assert.equal(calendarKeyTarget("ArrowUp", model, 9), 2);
  assert.equal(calendarKeyTarget("ArrowDown", model, 9), 30);
  assert.equal(calendarKeyTarget("ArrowRight", model, 2), 9);
  const week = { activeIdx: [3, 16, 17], days: [{ dow: 0 }] as { dow: number }[] } as Parameters<typeof calendarKeyTarget>[1];
  assert.equal(calendarKeyTarget("ArrowLeft", week, 17), 3, "ArrowLeft moves a week, not up a row");
  assert.equal(calendarKeyTarget("Home", model, 9), 2);
  assert.equal(calendarKeyTarget("End", model, 9), 30);
  assert.equal(calendarKeyTarget("ArrowUp", model, 2), null, "an edge is handled, with nowhere to go");
  assert.equal(calendarKeyTarget("a", model, 2), undefined);
});
