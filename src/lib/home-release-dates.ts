// A movie's Digital and Physical release dates from TMDB's `release_dates`
// (append_to_response or /movie/<id>/release_dates). Pure, zero-import.
//
// TMDB release types: 1 Premiere, 2 Theatrical (limited), 3 Theatrical,
// 4 Digital, 5 Physical, 6 TV. Only movies have them — TV has no equivalent.
//
// Region: the US entry, the same region the certification and the watch
// providers on the detail page come from. A type the US has no date for falls
// back to the EARLIEST date of that type in any region, so a title released
// only abroad still shows when it came out at all. Dates are returned
// date-only ("2024-05-01"); TMDB sends a UTC timestamp.

export type RawReleaseDates = {
  results?: { iso_3166_1?: string; release_dates?: { type?: number; release_date?: string }[] }[];
} | null | undefined;

export type HomeReleaseDates = { digital: string | null; physical: string | null };

const DIGITAL = 4;
const PHYSICAL = 5;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}/;

export function extractHomeReleaseDates(raw: RawReleaseDates): HomeReleaseDates {
  return { digital: pick(raw, DIGITAL), physical: pick(raw, PHYSICAL) };
}

function pick(raw: RawReleaseDates, type: number): string | null {
  let us: string | null = null;
  let earliest: string | null = null;
  for (const region of raw?.results ?? []) {
    for (const rd of region.release_dates ?? []) {
      if (rd.type !== type || !rd.release_date || !DATE_ONLY.test(rd.release_date)) continue;
      const date = rd.release_date.slice(0, 10);
      // ISO dates: lexicographic order is chronological order.
      if (region.iso_3166_1 === "US" && (us === null || date < us)) us = date;
      if (earliest === null || date < earliest) earliest = date;
    }
  }
  return us ?? earliest;
}
