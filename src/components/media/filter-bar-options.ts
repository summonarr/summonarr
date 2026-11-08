// The /movies and /tv filter bar's option lists and the readings built from
// them: the rating select's value, the active-filter chips, the provider order.
// Pure, so the unit suite pins it (tests/filter-bar-options.test.mts); the bar
// itself (filter-bar.tsx) only renders.
import type { Genre, WatchProvider } from "@/lib/tmdb-types";
import type { Translator } from "@/lib/i18n/translate";
import type { BrowseFilters, PendingDelta } from "@/lib/browse-filters";

// Labels are catalog keys, translated at render (module scope has no locale).
export const SORT_OPTIONS = [
  { value: "popularity.desc",     labelKey: "media.filter.sort.popular" },
  { value: "vote_average.desc",   labelKey: "media.filter.sort.topRated" },
  { value: "release_date.desc",   labelKey: "media.filter.sort.newest" },
  { value: "release_date.asc",    labelKey: "media.filter.sort.oldest" },
];

export type RatingOption = { value: string; label?: string; labelKey?: string; pct?: number };

// A `label` is a literal (brand + number, same in every language); `labelKey`
// + `pct` is translated at render.
export const RATING_OPTIONS: RatingOption[] = [
  { value: "",          labelKey: "media.filter.anyRating" },
  { value: "imdb:6",    label: "IMDb 6+" },
  { value: "imdb:6.5",  label: "IMDb 6.5+" },
  { value: "imdb:7",    label: "IMDb 7+" },
  { value: "imdb:7.5",  label: "IMDb 7.5+" },
  { value: "imdb:8",    label: "IMDb 8+" },
  { value: "imdb:8.5",  label: "IMDb 8.5+" },
  { value: "imdb:9",    label: "IMDb 9+" },
  // No glyphs: the IMDb and TMDB rows of this one <select> carry none, so a
  // tomato/popcorn prefix on the RT rows alone read as two styles in one list
  // (and leaked into the active-filter chip).
  { value: "rt:50",     label: "RT 50%+" },
  { value: "rt:60",     label: "RT 60%+" },
  { value: "rt:70",     label: "RT 70%+" },
  { value: "rt:80",     label: "RT 80%+" },
  { value: "rt:90",     label: "RT 90%+" },
  { value: "rta:60",   labelKey: "media.filter.audienceScore", pct: 60 },
  { value: "rta:70",   labelKey: "media.filter.audienceScore", pct: 70 },
  { value: "rta:80",   labelKey: "media.filter.audienceScore", pct: 80 },
  { value: "rta:90",   labelKey: "media.filter.audienceScore", pct: 90 },
  { value: "tmdb:6",    label: "TMDB 6+" },
  { value: "tmdb:7",    label: "TMDB 7+" },
  { value: "tmdb:7.5",  label: "TMDB 7.5+" },
  { value: "tmdb:8",    label: "TMDB 8+" },
  { value: "tmdb:8.5",  label: "TMDB 8.5+" },
  { value: "tmdb:9",    label: "TMDB 9+" },
];

export const VOTE_COUNT_OPTIONS = ["", "100", "250", "500", "1000", "5000", "10000"];

export function ratingOptionLabel(t: Translator, o: RatingOption): string {
  return o.labelKey ? t(o.labelKey, o.pct !== undefined ? { pct: o.pct } : undefined) : (o.label ?? o.value);
}

// "1,000+ votes". Grouped by hand with the catalog's separator rather than
// Intl.NumberFormat: the <option> text is server-rendered, and the server's and
// browser's ICU data can disagree on grouping (guardrail 16's locale cousin).
export function voteCountLabel(t: Translator, value: string): string {
  if (!value) return t("media.filter.anyVotes");
  const n = value.replace(/\B(?=(\d{3})+(?!\d))/g, t("media.filter.thousandsSeparator"));
  return t("media.filter.votesMin", { n });
}

/** The rating select's value: the ratingFilter, else the TMDB minimum as `tmdb:N`. */
export function activeRatingValue(f: Pick<BrowseFilters, "minRating" | "ratingFilter">): string {
  return f.ratingFilter ? f.ratingFilter : f.minRating ? `tmdb:${f.minRating}` : "";
}

/** What a pick in the rating select changes: TMDB's own minimum, or a ratingFilter. */
export function ratingDelta(value: string): PendingDelta {
  if (!value) return { minRating: undefined, ratingFilter: undefined };
  if (value.startsWith("tmdb:")) return { minRating: value.slice(5), ratingFilter: undefined };
  return { ratingFilter: value, minRating: undefined };
}

export function ratingChipLabel(t: Translator, minRating?: string, ratingFilter?: string): string | null {
  if (ratingFilter) {
    const opt = RATING_OPTIONS.find((o) => o.value === ratingFilter);
    return opt ? ratingOptionLabel(t, opt) : ratingFilter;
  }
  if (minRating) {
    const opt = RATING_OPTIONS.find((o) => o.value === `tmdb:${minRating}`);
    return opt ? ratingOptionLabel(t, opt) : `TMDB ${minRating}+`;
  }
  return null;
}

/**
 * The rating select's options. An active value the list doesn't hold (a shared
 * link's `minRating=6.5`, `ratingFilter=imdb:5`) is added after "Any rating",
 * labelled as its chip is: a controlled <select> with no matching option shows
 * its first one, so the select said "Any rating" while the chip showed the
 * filter.
 */
export function ratingSelectOptions(t: Translator, active: string): { value: string; label: string }[] {
  const options = RATING_OPTIONS.map((o) => ({ value: o.value, label: ratingOptionLabel(t, o) }));
  if (!active || RATING_OPTIONS.some((o) => o.value === active)) return options;
  const label = active.startsWith("tmdb:")
    ? ratingChipLabel(t, active.slice(5), undefined)
    : ratingChipLabel(t, undefined, active);
  return [options[0], { value: active, label: label ?? active }, ...options.slice(1)];
}

const TOP_PROVIDER_IDS = new Set([8, 9, 337, 1899, 15, 350, 386, 531]);

// The big services first, then the rest by name. Pinned locale: bare
// localeCompare uses the RUNTIME default — Node's on the server, the browser's
// on the client — and this list is rendered into SSR HTML. Czech and Slovak
// sort the "ch" digraph after "h" (moving the real provider "Chili"),
// Lithuanian and Latvian collate Y next to I, and Estonian puts Z between S and
// T; any of those reorders the <option> list between server and client and
// reports a hydration mismatch. Guardrail 16 is written around the clock, but
// locale is the same class of bug.
export function sortProviders(providers: readonly WatchProvider[]): WatchProvider[] {
  return providers.slice().sort((a, b) => {
    const aTop = TOP_PROVIDER_IDS.has(a.provider_id);
    const bTop = TOP_PROVIDER_IDS.has(b.provider_id);
    if (aTop && !bTop) return -1;
    if (!aTop && bTop) return 1;
    return a.provider_name.localeCompare(b.provider_name, "en");
  });
}

export type FilterChip = { key: string; label: string; remove: PendingDelta };

/**
 * The active-filter chips. A filter whose name the page can't supply still
 * gets a chip (a provider id the list doesn't name — the provider fetch failed,
 * or a stale id; a genre id it doesn't know): otherwise that filter was active
 * with no way to see or remove it.
 */
export function filterChips(
  f: BrowseFilters,
  ctx: { genres: readonly Genre[]; providers: readonly WatchProvider[]; showCertification: boolean },
  t: Translator,
): FilterChip[] {
  const chips: FilterChip[] = [];
  if (f.genreId) {
    chips.push({ key: "genre", label: ctx.genres.find((g) => String(g.id) === f.genreId)?.name ?? f.genreId, remove: { genreId: undefined } });
  }
  if (f.keywordId) {
    chips.push({ key: "keyword", label: f.keywordName ?? t("media.filter.keyword"), remove: { keywordId: undefined, keywordName: undefined } });
  }
  if (f.companyId) {
    chips.push({ key: "company", label: f.companyName ?? t("media.filter.studio"), remove: { companyId: undefined, companyName: undefined } });
  }
  if (f.networkId) {
    chips.push({ key: "network", label: f.networkName ?? t("media.filter.network"), remove: { networkId: undefined, networkName: undefined } });
  }
  if (f.certification && ctx.showCertification) {
    chips.push({ key: "cert", label: t("media.filter.certUpTo", { rating: f.certification }), remove: { certification: undefined } });
  }
  const rating = ratingChipLabel(t, f.minRating, f.ratingFilter);
  if (rating) {
    chips.push({ key: "rating", label: rating, remove: { minRating: undefined, ratingFilter: undefined } });
  }
  if (f.minVoteCount) {
    chips.push({ key: "votes", label: voteCountLabel(t, f.minVoteCount), remove: { minVoteCount: undefined } });
  }
  if (f.fromYear) {
    chips.push({ key: "from", label: t("media.filter.fromChip", { year: f.fromYear }), remove: { fromYear: undefined } });
  }
  if (f.toYear) {
    chips.push({ key: "to", label: t("media.filter.toChip", { year: f.toYear }), remove: { toYear: undefined } });
  }
  if (f.watchProvider) {
    const activeProviderName = ctx.providers.find((p) => String(p.provider_id) === f.watchProvider)?.provider_name;
    chips.push({
      key: "provider",
      label: activeProviderName ?? t("media.filter.serviceChip", { id: f.watchProvider }),
      remove: { watchProvider: undefined },
    });
  }
  if (f.sortBy && f.sortBy !== "popularity.desc") {
    const o = SORT_OPTIONS.find((x) => x.value === f.sortBy);
    chips.push({ key: "sort", label: o ? t(o.labelKey) : f.sortBy, remove: { sortBy: undefined } });
  }
  if (f.hideAvailable) {
    chips.push({ key: "hide", label: t("media.filter.hidingAvailable"), remove: { hideAvailable: undefined } });
  }
  return chips;
}
