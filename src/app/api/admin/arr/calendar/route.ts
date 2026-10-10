import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { parseCalendarWindow, MAX_CALENDAR_DAYS } from "@/lib/arr-calendar";
import { loadCalendar } from "@/lib/arr-calendar-data";
import { translatorForRequest } from "@/lib/i18n/server-locale";

// Admin → Calendar (ADMIN): what Radarr and Sonarr have coming up (and just
// had), from their own calendars — every configured instance, live.
//   GET ?start=<ISO>&end=<ISO>[&unmonitored=1] — at most MAX_CALENDAR_DAYS.
//   → { instances, errors, entries }: one entry per episode airing and per
//   movie release date (in cinemas / physical / digital) in the window, each
//   with whether the arr has the file (downloaded / missing / upcoming /
//   unmonitored / released). An instance that could not be read is named in
//   `errors` — its titles are absent, not "nothing airing".
export const GET = withAdmin(async (req) => {
  const t = translatorForRequest(req);
  const q = req.nextUrl.searchParams;
  const range = parseCalendarWindow(q.get("start"), q.get("end"));
  if (!range) return NextResponse.json({ error: t("apiAdmin.arr.calendarWindowInvalid", { days: MAX_CALENDAR_DAYS }) }, { status: 400 });
  const unmonitored = q.get("unmonitored") === "1" || q.get("unmonitored") === "true";
  return NextResponse.json(await loadCalendar(range.start, range.end, unmonitored, new Date()));
});
