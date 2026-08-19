import "server-only";
import { prisma } from "@/lib/prisma";
import type { MediaType, RecommendationSeed } from "@/generated/prisma";
import type { TmdbMedia } from "@/lib/tmdb-types";
import { getMovieSuggestions, getTVSuggestions, getTrending, getPopularMovies, getPopularTV, SUGGESTIONS_CACHE_MAX } from "@/lib/tmdb";
import { resolveLinkedMediaServerUserIds } from "@/lib/my-watch-history";
import { settleLimit } from "@/lib/concurrency";
import { attachRatingsUnified } from "@/lib/omdb-availability";
import { getBlacklistSet } from "@/lib/blacklist";
import { batchCreateMany, BATCH_TX_TIMEOUT } from "@/lib/cron-auth";

// "For You" recommendation engine. Seeds are drawn from a user's own watched
// PlayHistory + WatchlistItem, fanned out through TMDB's existing similar/
// recommendations wrappers, scored, and cached per-user in UserRecommendation
// by the warm-recommendations cron. getUserRecommendations is the only
// live-request-path read — it never calls TMDB.

// "The last 100 titles you played". Note TITLES, not PlayHistory rows: one row is
// one EPISODE, so 100 rows can be a single series — the groupBy below collapses
// to distinct titles first, which is the unit a seed actually is.
//
// Deeper history is the point: at the original 20 slots the engine only ever saw
// a sliver of a real library. The cost is bounded by the shared 7-day TMDB
// suggestion cache (tmdb.ts) — seeds repeat across runs and across users, so a
// warm cycle issues far fewer requests than the cold worst case of 2 per seed.
const MAX_WATCH_HISTORY_SEEDS = 100;
const MAX_WATCHLIST_SEEDS = 24;
// A request is the strongest single-title signal a user can emit — they filled
// in a form asking for it — and for local/OIDC accounts with no linked media-
// server identity it is often the ONLY signal: their history reads resolve to
// zero server users, so before this pool existed those users' shelves were
// built from nothing at all. Every status seeds (even DECLINED — the admin
// vetoed the fulfilment, not the taste); the overfetch absorbs the per-
// arrInstance duplicate rows the unique key permits, collapsed newest-wins.
const MAX_REQUEST_SEEDS = 24;
const REQUEST_SEED_OVERFETCH = 3;
const SEED_RECENCY_WINDOW_MS = 180 * 24 * 60 * 60 * 1000;
// STORE the whole rated shortlist; SERVE the historical 200. The two used to be
// one number, which silently threw away paid-for work: ranks 200-299 were
// scored AND run through the ratings prior every cron, then discarded. Storing
// them costs one hundred small rows per user and buys instant backfill — when
// the read-time drift filter drops a row (watched, hidden, requested since the
// last cron), the next-ranked reserve row takes its place at the SAME render
// instead of the shelf shrinking for up to 12h.
//
// Keep MAX_STORED equal to RATING_SHORTLIST (declared below): larger would
// store unrated tails the quality prior never saw; smaller re-creates the
// discard. The serve cap is what every read surface sees — page size and the
// enrichment fan-out are tuned to it, so raise it deliberately or not at all.
const MAX_STORED_RECOMMENDATIONS_PER_USER = 300;
const MAX_SERVED_RECOMMENDATIONS = 200;
const SEED_CONCURRENCY = 5;
const USER_CONCURRENCY = 5;
const ACTIVE_USER_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

// ── Scoring ────────────────────────────────────────────────────────────────
// A candidate's score is the sum, over every seed that surfaced it, of
//
//     seedTypeWeight × recencyFactor(seed) × countFactor(seed) × positionFactor(item)
//
// Each factor answers a different question, and the previous single-factor model
// (position in the SEED LIST, nothing else) got two of them wrong.

// How fast a seed's influence fades with age, and how far it can fade. The floor
// is what makes deep history worth seeding at all: a pure half-life sends a
// three-year-old watch to ~0.004, so the extra slots above would buy nothing.
// At FLOOR 0.25 / half-life 180d a seed is worth 1.0 today, 0.63 at six months,
// 0.42 at a year, and never less than a quarter of a fresh one.
//
// This replaces weighting by POSITION IN THE SEED LIST, which was ordered
// count-first — so a movie watched once last week ranked below a show binged
// years ago, and its recommendations were weighted as though it mattered less.
const SEED_RECENCY_HALF_LIFE_MS = 180 * 24 * 60 * 60 * 1000;
const SEED_RECENCY_FLOOR = 0.25;

// Watching something repeatedly is a real signal, but PlayHistory writes one row
// PER EPISODE, so raw counts put a 62-episode series two orders of magnitude
// above any film. log10 at a 0.3 coefficient compresses that to 1.0x for a movie
// vs ~1.5x for the whole of Breaking Bad — present, but unable to outrun the 4x
// span of recency above. Weighting by raw count is the bug this file has always
// been designed against (see selectSeeds); this is the smallest dose that keeps
// the signal without reopening it.
const SEED_COUNT_WEIGHT = 0.3;

// Position of a suggestion WITHIN its seed's list. TMDB returns its behavioural
// /recommendations first and the cruder /similar after (see getMovieSuggestions),
// so this favours the former without either endpoint being named here.
//
// It exists because the list is now 40 long (SUGGESTIONS_CACHE_MAX, widened from
// 18). Scoring every entry equally meant the 40th — a weak keyword match — voted
// as loudly as the 1st, which diluted the ranking exactly as the pool grew.
// 1/(1 + i/10) is 1.0 at the head, 0.53 by the 10th and 0.20 at the 40th: sharp
// where it matters, with a long tail that still lets broad corroboration promote
// a title many seeds agree on.
const SUGGESTION_POSITION_K = 10;

// ── Language consistency ───────────────────────────────────────────────────
// Someone who watches English-language films should not have a shelf sprinkled
// with one-off Korean or Spanish titles just because a single seed pointed
// there. TMDB's /similar in particular crosses languages freely.
//
// The profile is built from the suggestion pool itself, weighted by
// contribution — NOT from the seeds, which have no language to read: seeds come
// from a PlayHistory groupBy and that table stores no language column, so
// getting one per seed would cost a TMDB details fetch each (100 per user per
// run). The pool is a sound proxy precisely because it is generated FROM the
// seeds: 95 English-ish seeds produce overwhelmingly English suggestions, and a
// lone foreign-language seed contributes a correspondingly small share.
//
// A language reaching LANGUAGE_FULL_SHARE of the weighted pool is treated as
// fully part of the viewer's taste (so a genuine anime-plus-Hollywood diet
// keeps both), and anything below that scales down toward a floor rather than
// being cut — this is a de-emphasis, not a filter, and a title corroborated by
// many seeds can still outrank on merit.
const LANGUAGE_FULL_SHARE = 0.15;
const LANGUAGE_FLOOR = 0.35;

// ── Quality prior ──────────────────────────────────────────────────────────
// Relevance ("this resembles what you watch") is not the same as worth
// watching. After relevance ranking, the top slice is re-weighted by what the
// rating sources say — IMDb/RT/Metacritic/Trakt/Letterboxd/MAL via MDBList,
// with OMDB filling gaps, plus TMDB's own score which every candidate already
// carries.
//
// EVIDENCE-WEIGHTED, IMDb-led. The original prior took an unweighted mean over
// whichever sources answered and applied it at one fixed strength — so a lone
// Trakt percentage re-ranked a title exactly as hard as IMDb + RT + Metacritic
// in agreement, and an IMDb score backed by a million votes counted no more
// than one backed by three hundred, even though both providers ship the vote
// count. Now each source carries a weight (IMDb's grows with its vote depth —
// it is the deepest vote base any of these providers has, which is why it
// anchors the blend), the quality figure is the weighted mean, and the
// multiplier's strength scales with the total evidence behind it: a verdict
// corroborated by deep-voted IMDb plus the critic aggregates pulls harder than
// the old prior ever did, while a thin single-source opinion barely registers.
//
// Still deliberately centred: NEUTRAL is roughly the mean rating of a
// mainstream title, so the multiplier only pulls a candidate away from its
// relevance rank when the sources genuinely disagree with the crowd. An
// UNRATED title with a real audience scores exactly 1.0 — absence of PROVIDER
// data must never read as "bad", or the shelf would quietly become "whatever
// OMDB happened to cover". The one carve-out is OBSCURITY_DAMP: unrated AND
// under the TMDB vote bar means nobody anywhere has weighed in, and that
// tail-of-/similar junk used to outrank known-mediocre titles the prior had
// pulled down.
const RATING_SHORTLIST = 300;
// ── Cold-start fallback ────────────────────────────────────────────────────
// A user with no seeds — no linked watch history, empty watchlist, no requests
// — used to get a conclusive empty: a blank page with an empty-state blurb,
// for up to 12h between crons, exactly when the app most needs to make a first
// impression. Their shelf now fills from the prewarmed trending/popular caches
// (warm-list-cache keeps them hot, so the marginal cost is ~zero), run through
// the same quality prior so it is at least a GOOD generic shelf.
//
// The honesty engineering is the load-bearing part: fallback rows are labeled
// "popular right now", never given a fabricated reason line, and never wear a
// match-tier chip — a "Top match" on a title picked for everyone would erode
// the chip's meaning everywhere. Thin shelves top up to this target the same
// way, with fallback rows ranked strictly BELOW every real pick.
const FALLBACK_SHELF_TARGET = 100;
// Ceiling strength of the prior. Never applied bare: the effective strength is
// QUALITY_WEIGHT × confidence, where confidence = evidence/(evidence + PIVOT)
// saturates toward 1 as source weight accumulates. Deep-voted IMDb plus the
// critic aggregates lands around 0.75 effective — a stronger pull than the old
// flat 0.5, which is the point of the rework — while a lone thin source gets
// ~0.2-0.3, weaker than it used to wield. Raising the ceiling without the
// confidence term would resurrect exactly the single-source yank the term
// exists to prevent.
const QUALITY_WEIGHT = 0.9;
const QUALITY_NEUTRAL = 0.65;
const QUALITY_CONFIDENCE_PIVOT = 1.0;
const OBSCURITY_DAMP = 0.9;
// TMDB's score is the only one every candidate carries, so it would otherwise
// dominate the mean — but on a thinly-voted title it is noise (a 10.0 from four
// people), and the suggestion tail is full of exactly those. Below this many
// votes TMDB abstains and the title is judged on whatever else answered.
const MIN_TMDB_VOTES_FOR_QUALITY = 50;

// ── Per-source evidence weights ────────────────────────────────────────────
// IMDb is the anchor: the deepest vote base of any provider here, and the one
// the ratings pipeline actually delivers a vote count for (MDBList sends it
// bare, OMDB comma-formatted). Its weight is shrunk by that count —
// MAX × votes/(votes + PIVOT) — so at 100k+ votes it outweighs any other
// single source ~3:1, at the PIVOT it carries half that, and a 300-vote
// obscurity speaks at a whisper. A rating with NO count attached (MDBList
// sometimes omits it) gets a flat middling weight: trusted, but never
// anchor-strength on unproven depth.
const IMDB_QUALITY_WEIGHT_MAX = 3;
const IMDB_QUALITY_VOTE_PIVOT = 5000;
const IMDB_QUALITY_WEIGHT_UNKNOWN_VOTES = 1;
// RT critics + Metacritic: professional aggregates — no public vote depth to
// weigh, but editorially bounded, so they hold a full fixed vote each.
const CRITIC_QUALITY_WEIGHT = 1;
// Letterboxd and MAL: real communities with real depth (MAL is close to
// authoritative for anime, where IMDb coverage thins out), but no vote counts
// arrive for either, so they sit just below the critic tier.
const COMMUNITY_QUALITY_WEIGHT = 0.75;
// Trakt and RT audience: the noisiest of the set — small or self-selected
// voter pools, no counts. Present, but never decisive on their own.
const SECONDARY_QUALITY_WEIGHT = 0.5;
// TMDB: the thinnest crowd of all (the very reason this prior exists), shrunk
// by its own vote count like IMDb but from a far lower ceiling.
const TMDB_QUALITY_WEIGHT_MAX = 0.75;
const TMDB_QUALITY_VOTE_PIVOT = 1000;
// Deliberately EXCLUDED from the blend: mdblistScore is MDBList's own
// aggregate of the same per-source ratings already blended here, so admitting
// it would double-count every source it summarizes; rogerEbertRating is a
// single critic on an idiosyncratic 4-star scale with sparse coverage.

// ── Corroboration cap ──────────────────────────────────────────────────────
// A candidate's contributions no longer sum unbounded. Sorted strongest-first,
// the i-th contribution is scaled by DECAY^i, so total amplification over the
// single best contribution is bounded by 1/(1-DECAY) = 4x.
//
// This deliberately REVERSES the original "broad corroboration wins" design.
// What that design actually selected for, at 124 seeds, was the centroid of
// the user's taste: the titles a little similar to EVERYTHING — sequels,
// same-franchise entries, the most generic picks — collected dozens of small
// contributions and deterministically owned page 1, while a strong match
// surfaced by one or two seeds could never catch up no matter how good.
// Bounding at 4x keeps corroboration meaningful (4x is still a big lead) while
// letting a first-place single-seed match compete with a wall of 40th-place
// agreements. The trade: a title genuinely adored across a whole library ranks
// somewhat lower than before — accepted, page 1 was drowning in its franchise.
const CORROBORATION_DECAY = 0.75;

// ── Abandoned-play dampening ───────────────────────────────────────────────
// The engine only ever learned from what the user LIKED — a title they started
// and demonstrably bailed on could come straight back as a recommendation.
// Sampled-but-unfinished titles (watched:false rows only; anything with a
// watched:true row is excluded upstream) are dampened, never excluded: a 15%
// abandon might be revisited someday, it just should not spend shelf rank.
//
// Two guards make it safe, and both exist for the same reason — watched:false
// is NOISY:
//   - the ratio guard is CUMULATIVE: a movie watched in two weeknight halves
//     has zero watched:true rows yet ~100% total playtime, so the per-row flag
//     alone would dampen the most normal viewing pattern there is. Only under
//     35% TOTAL playtime reads as a bail;
//   - the settle window: a pause five days ago is a pause, not a verdict. The
//     signal only counts once the last touch is two weeks old.
// A row with no usable runtime is skipped — can't judge a ratio you can't
// compute. Fires per-title only, never on a neighborhood of similar titles.
const ABANDON_DAMP = 0.3;
const ABANDON_MAX_CUMULATIVE_RATIO = 0.35;
const ABANDON_SETTLE_MS = 14 * 24 * 60 * 60 * 1000;
const ABANDON_SCAN_LIMIT = 500;

// Share of the weighted pool a language holds → its multiplier.
function languageFactor(share: number): number {
  return LANGUAGE_FLOOR + (1 - LANGUAGE_FLOOR) * Math.min(1, share / LANGUAGE_FULL_SHARE);
}

// The bands behind the "Top match" / "Strong match" chip, as fractions of the
// viewer's own ranked set.
//
// Banded by RANK, not by score. A raw score is a sum of seed weights, so its
// magnitude tracks how much history someone has rather than how good the pick
// is — two people cannot be compared, and even within one shelf the ratio to
// the top score depends on whether that top title happened to be corroborated
// by 30 seeds or 3. Rank position is the thing the engine actually asserts.
//
// The chip earns its place because SORTING HIDES THE RANKING: choose Newest or
// Highest rated and the engine's ordering is gone from the page entirely. This
// is what carries it through.
const MATCH_TIER_TOP_FRACTION = 0.1;
const MATCH_TIER_STRONG_FRACTION = 0.33;

// index is the position in the viewer's full ranked set, AFTER drift filtering
// but BEFORE any page-level type/availability filter — so narrowing to TV never
// re-labels a title that did not move.
function matchTierFor(index: number, total: number): "top" | "strong" | undefined {
  if (total <= 0) return undefined;
  // ceil, so a shelf of any size still labels its best pick rather than
  // rounding the whole top band away.
  if (index < Math.ceil(total * MATCH_TIER_TOP_FRACTION)) return "top";
  if (index < Math.ceil(total * MATCH_TIER_STRONG_FRACTION)) return "strong";
  return undefined;
}

// Watchlist is an unambiguous single-person signal (added through the Summonarr
// UI by whoever is signed in); watch-history via resolveLinkedMediaServerUserIds
// can represent a shared Plex/Jellyfin household profile. Watchlist gets a
// higher per-seed weight but fewer slots, so history still dominates volume.
const WATCHLIST_SEED_WEIGHT = 1.5;
const WATCH_HISTORY_SEED_WEIGHT = 1.0;
// Same weight as the watchlist: both are unambiguous single-person acts. The
// two never double-count — a title in several pools seeds exactly once (see
// the dedup in selectSeeds).
const REQUEST_SEED_WEIGHT = 1.5;

export interface RecommendationCandidate {
  tmdbId: number;
  mediaType: MediaType;
  title: string;
  overview: string | null;
  posterPath: string | null;
  backdropPath: string | null;
  releaseDate: string | null;
  voteAverage: number;
  score: number;
  rank: number;
  // The single strongest seed that surfaced this candidate, and how many seeds
  // surfaced it in total. `score` says HOW MUCH the engine likes a title;
  // these say WHY, which is what the /for-you page shows the user.
  //
  // Nullable because a cold-start FALLBACK row has no seed to name: it carries
  // reasonSource TRENDING with the other three null (and seedCount 0), which
  // keeps the read path's all-four-non-null gate closed — the one honesty rule
  // the fallback feature hangs on is that it may never fabricate a "Because
  // you watched…". Real candidates always fill all four.
  reasonTmdbId: number | null;
  reasonTitle: string | null;
  reasonMediaType: MediaType | null;
  reasonSource: RecommendationSeed | null;
  seedCount: number;
}

interface Seed {
  tmdbId: number;
  mediaType: MediaType;
  weight: number;
  // Carried purely so a candidate can name its reason. The title is denormalized
  // off the seed row (PlayHistory.title / WatchlistItem.title) rather than looked
  // up later — a title watched years ago may have no TMDB cache row left.
  title: string;
  source: RecommendationSeed;
}

function candidateKey(tmdbId: number, mediaType: MediaType): string {
  return `${tmdbId}:${mediaType}`;
}

function toDbMediaType(m: "movie" | "tv"): MediaType {
  return m === "movie" ? "MOVIE" : "TV";
}

function toTmdbMediaType(m: MediaType): "movie" | "tv" {
  return m === "MOVIE" ? "movie" : "tv";
}

// How much a seed still counts, given when it was last watched (or added to the
// watchlist). Bounded below by SEED_RECENCY_FLOOR so old-but-real taste keeps a
// vote. An absent timestamp is treated as maximally old rather than dropped —
// the seed is genuine, we just can't date it.
function recencyFactor(at: Date | null | undefined, now: number): number {
  if (!at) return SEED_RECENCY_FLOOR;
  // Clamp negatives: a clock skew that puts a watch in the future must not
  // amplify a seed past a fresh one.
  const ageMs = Math.max(0, now - at.getTime());
  const decayed = Math.pow(0.5, ageMs / SEED_RECENCY_HALF_LIFE_MS);
  return SEED_RECENCY_FLOOR + (1 - SEED_RECENCY_FLOOR) * decayed;
}

// Repeat-watch signal, log-compressed — see SEED_COUNT_WEIGHT.
function countFactor(count: number): number {
  return 1 + SEED_COUNT_WEIGHT * Math.log10(Math.max(1, count));
}

// Weight of a single suggestion by its rank within its seed's list.
function positionFactor(index: number): number {
  return 1 / (1 + index / SUGGESTION_POSITION_K);
}

// Seeds are weighted ABSOLUTELY (by their own age and repeat count), not by
// their position in the selected list. Two consequences worth knowing:
//   - a seed's weight no longer depends on how many other seeds there are, so
//     raising MAX_WATCH_HISTORY_SEEDS cannot dilute the ones already there;
//   - the top seed is no longer pinned to exactly 1.0 — a viewer whose most
//     recent watch was months ago has uniformly lower weights. Scores are only
//     ever compared WITHIN one user, so that is immaterial to the ranking.
function weightSeeds(
  rows: { tmdbId: number; mediaType: MediaType; title: string; lastAt?: Date | null; count?: number }[],
  typeWeight: number,
  source: RecommendationSeed,
  now: number,
): Seed[] {
  return rows.map((r) => ({
    tmdbId: r.tmdbId,
    mediaType: r.mediaType,
    title: r.title,
    source,
    weight: typeWeight * recencyFactor(r.lastAt, now) * countFactor(r.count ?? 1),
  }));
}

async function selectSeeds(userId: string, linkedServerUserIds: string[]): Promise<Seed[]> {
  // History seeds track CURRENT taste. With the recency-first ordering above,
  // the windowed query and the all-time top-up together yield exactly "the most
  // recently played MAX_WATCH_HISTORY_SEEDS titles": the window returns the
  // newest of them, and the top-up extends backwards past 180 days only when a
  // quiet viewer has not filled the slots.
  //
  // (The window predates the ordering change, when it was load-bearing against
  // a different failure: count-first selection let a years-old 200-episode
  // binge own every slot while films — one row each — never seeded at all.
  // Ordering by recency addresses that at the source; the window now just
  // bounds the common query.)
  //
  // Windowed rows come FIRST, then the remaining slots TOP UP from all-time
  // history. A busy user with only 2-3 recent watches used to seed from just
  // those (all-time fired only at exactly zero windowed rows), so their pool
  // was thin; old favorites now fill the tail slots — at the taper's lower
  // weights, so they can never outrank recent taste. A fully dormant household
  // (zero windowed rows) degenerates to pure all-time seeding, the same
  // fallback as before: seeds.length === 0 is a CONCLUSIVE empty to the
  // caller, which would clear an established shelf. The exclusion set
  // (buildExclusionSet) stays all-time on purpose: an old watch must still
  // never come back as a "new" recommendation.
  const groupHistory = (windowed: boolean, take: number) =>
    prisma.playHistory.groupBy({
      by: ["tmdbId", "mediaType"],
      where: {
        mediaServerUserId: { in: linkedServerUserIds },
        watched: true,
        tmdbId: { not: null },
        mediaType: { not: null },
        ...(windowed ? { startedAt: { gte: new Date(Date.now() - SEED_RECENCY_WINDOW_MS) } } : {}),
      },
      _count: { tmdbId: true },
      // NOTE the orderBy below is RECENCY-first. It used to be count-first,
      // which did not select "what you have been watching" but "what you have
      // the most rows for" — and because PlayHistory writes one row per
      // episode, that meant long series crowded out every film regardless of
      // when either was watched. Play count still matters, but as a weight
      // (countFactor) rather than as the selection key.
      // title rides along in the aggregate so naming the seed ("Because you
      // watched X") costs no second query. PlayHistory.title is the show/movie
      // title — episodeTitle is a separate column — so it is already the right
      // label for a TV seed. _max picks one arbitrary row's title within the
      // group; every row in a (tmdbId, mediaType) group is the same title
      // except for upstream renames, where the newest spelling is fine.
      _max: { startedAt: true, title: true },
      orderBy: [{ _max: { startedAt: "desc" } }, { _count: { tmdbId: "desc" } }],
      take,
    });

  const [windowedRows, watchlistRows, requestRows] = await Promise.all([
    linkedServerUserIds.length === 0
      ? Promise.resolve([])
      : groupHistory(true, MAX_WATCH_HISTORY_SEEDS),
    prisma.watchlistItem.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: MAX_WATCHLIST_SEEDS,
      select: { tmdbId: true, mediaType: true, title: true, createdAt: true },
    }),
    // Every own request, any status (see MAX_REQUEST_SEEDS). requestedBy is the
    // row's attributed user, which covers on-behalf requests too — the row has
    // no created-by column, so "requests attributed to this user" is the finest
    // grain the schema can express.
    prisma.mediaRequest.findMany({
      where: { requestedBy: userId },
      orderBy: { createdAt: "desc" },
      take: MAX_REQUEST_SEEDS * REQUEST_SEED_OVERFETCH,
      select: { tmdbId: true, mediaType: true, title: true, createdAt: true },
    }),
  ]);

  // Collapse the per-arrInstance duplicates (one user may hold an HD and a 4K
  // row for the same title): rows arrive newest-first, so first-wins is
  // newest-wins.
  const seenRequestKeys = new Set<string>();
  const requestSeedRows: { tmdbId: number; mediaType: MediaType; title: string; createdAt: Date }[] = [];
  for (const r of requestRows) {
    const key = candidateKey(r.tmdbId, r.mediaType);
    if (seenRequestKeys.has(key)) continue;
    seenRequestKeys.add(key);
    requestSeedRows.push(r);
    if (requestSeedRows.length >= MAX_REQUEST_SEEDS) break;
  }

  let historyRows = windowedRows;
  if (linkedServerUserIds.length > 0 && windowedRows.length < MAX_WATCH_HISTORY_SEEDS) {
    // Overfetch by the windowed count: every windowed title also sits in the
    // all-time grouping, so the worst case needs that many extras to still
    // fill the remaining slots after dedup.
    const seen = new Set(windowedRows.map((r) => `${r.tmdbId}:${r.mediaType}`));
    const allTime = await groupHistory(false, MAX_WATCH_HISTORY_SEEDS + seen.size);
    historyRows = [
      ...windowedRows,
      ...allTime.filter((r) => !seen.has(`${r.tmdbId}:${r.mediaType}`)),
    ].slice(0, MAX_WATCH_HISTORY_SEEDS);
  }

  // groupBy's TS types don't narrow tmdbId/mediaType past their nullable
  // column types even though the where clause already excludes nulls.
  const historySeeds = historyRows
    .filter((r) => r.tmdbId != null && r.mediaType != null)
    .map((r) => ({
      tmdbId: r.tmdbId as number,
      mediaType: r.mediaType as MediaType,
      // PlayHistory.title is NOT NULL, but _max over an empty group is typed
      // nullable; fall back to the id so a reason is never a blank string.
      title: r._max.title ?? `TMDB #${r.tmdbId}`,
      // Both were already being fetched to ORDER the groups; they now also
      // weight them, which is the whole point of the rework.
      lastAt: r._max.startedAt,
      count: r._count.tmdbId,
    }));

  // One `now` for the whole selection: reading the clock per seed would let a
  // slow query change the weights partway down the list.
  const now = Date.now();

  // The app's core loop is watchlist -> request -> watch, so one title can sit
  // in all three pools at once — and it must seed exactly ONCE. Priority is
  // history > watchlist > request: once watched, everything else is fulfilled
  // bookkeeping and the history seed carries the real signal (actual recency,
  // real play count); between the two explicit signals the weights are
  // identical (1.5), so which one keeps the slot changes nothing but the
  // reason wording, and watchlist keeps it as the earlier-established pool.
  const historyKeys = new Set(historySeeds.map((r) => candidateKey(r.tmdbId, r.mediaType)));
  const unwatchedListRows = watchlistRows.filter((r) => !historyKeys.has(candidateKey(r.tmdbId, r.mediaType)));
  const listKeys = new Set(unwatchedListRows.map((r) => candidateKey(r.tmdbId, r.mediaType)));
  const novelRequestRows = requestSeedRows.filter((r) => {
    const key = candidateKey(r.tmdbId, r.mediaType);
    return !historyKeys.has(key) && !listKeys.has(key);
  });

  return [
    ...weightSeeds(historySeeds, WATCH_HISTORY_SEED_WEIGHT, "WATCH_HISTORY", now),
    // A watchlist entry has no play count; its recency is when it was added.
    ...weightSeeds(
      unwatchedListRows.map((r) => ({ ...r, lastAt: r.createdAt })),
      WATCHLIST_SEED_WEIGHT,
      "WATCHLIST",
      now,
    ),
    // A request's recency is when it was placed.
    ...weightSeeds(
      novelRequestRows.map((r) => ({ ...r, lastAt: r.createdAt })),
      REQUEST_SEED_WEIGHT,
      "REQUEST",
      now,
    ),
  ];
}

// Wider than "the chosen seeds" on purpose: an already-known title elsewhere on
// a long watchlist (past the top-5 seeded) or an old watch (past the top-10
// seeded) must not leak back in as a "new" recommendation.
// Mirrors getUserHiddenSet's bound (hidden.ts): HiddenItem accumulates without
// limit, and this runs inside the cron fan-out AND on every /for-you render.
const MAX_EXCLUSION_HIDDEN = 10_000;

// Every title the user already KNOWS about, as candidateKeys. One reader shared
// by the compute-time exclusion AND the read-time drift filter, so the two can
// never disagree about what "already known" means — a title excluded at compute
// but not at read (or vice versa) either wastes a stored slot or resurfaces
// something the user acted on. Covers:
//   - the full watchlist and all watched history (the original set);
//   - HiddenItem — "not interested" clicks. These were only removed at render
//     time by attachAllAvailability, so every hide permanently killed one of
//     the stored slots and matchTier was assigned to cards nobody ever saw.
//     Read DIRECTLY rather than via getUserHiddenSet: that helper lowercases
//     its keys to match attach-all's TMDB casing, while candidateKey uses the
//     Prisma enum casing — reusing it would silently never match anything;
//   - the user's own OPEN requests (PENDING/APPROVED) — recommending a title
//     whose request button 409s is a dead card. AVAILABLE stays recommendable
//     on purpose (the "On your server" filter is a feature), and a plain
//     DECLINED stays too (it is re-requestable);
//   - permanentlyDeclined requests — the request POST 403s those forever;
//   - the user's own DeletionVotes — "Because you watched X" on a title the
//     user voted to DELETE is the most jarring card the shelf can produce;
//   - the admin blacklist (global, 30s-cached in blacklist.ts) — visible but
//     unrequestable everywhere else, so a slot spent on it is wasted. Note the
//     deliberate divergence from attachAllAvailability, which KEEPS blacklisted
//     titles visible in general discovery: a browse grid states facts about the
//     catalog, a recommendation is advice to act.
async function collectKnownTitleKeys(userId: string, linkedServerUserIds: string[]): Promise<Set<string>> {
  const [watchlistRows, watchedRows, hiddenRows, requestRows, voteRows, blacklistSet] = await Promise.all([
    prisma.watchlistItem.findMany({ where: { userId }, select: { tmdbId: true, mediaType: true } }),
    linkedServerUserIds.length === 0
      ? Promise.resolve([])
      : // groupBy, not findMany + distinct. Prisma applies `distinct` CLIENT-side
        // — verified by capturing the emitted SQL, which is byte-identical with
        // and without it — so every watch row crossed the wire and was deduped
        // in Node. Only the distinct pairs are ever used, and a heavy viewer has
        // thousands of rows collapsing to a few hundred titles. groupBy compiles
        // to a real GROUP BY, so Postgres does the dedup. The result shape is
        // the same {tmdbId, mediaType}, so the consumers below are unchanged.
        prisma.playHistory.groupBy({
          by: ["tmdbId", "mediaType"],
          where: {
            mediaServerUserId: { in: linkedServerUserIds },
            watched: true,
            tmdbId: { not: null },
            mediaType: { not: null },
          },
        }),
    prisma.hiddenItem.findMany({
      where: { userId },
      select: { tmdbId: true, mediaType: true },
      orderBy: { createdAt: "desc" },
      take: MAX_EXCLUSION_HIDDEN,
    }),
    prisma.mediaRequest.findMany({
      // Across every arrInstance: a request on ANY instance makes the title known.
      where: {
        requestedBy: userId,
        OR: [{ status: { in: ["PENDING", "APPROVED"] } }, { permanentlyDeclined: true }],
      },
      select: { tmdbId: true, mediaType: true },
    }),
    prisma.deletionVote.findMany({ where: { userId }, select: { tmdbId: true, mediaType: true } }),
    getBlacklistSet(),
  ]);

  // blacklistKey (blacklist.ts) emits the same "{tmdbId}:{MOVIE|TV}" shape as
  // candidateKey, so the cached set can be adopted wholesale.
  const known = new Set<string>(blacklistSet);
  for (const r of watchlistRows) known.add(candidateKey(r.tmdbId, r.mediaType));
  for (const r of watchedRows) {
    if (r.tmdbId != null && r.mediaType != null) known.add(candidateKey(r.tmdbId, r.mediaType));
  }
  for (const r of hiddenRows) known.add(candidateKey(r.tmdbId, r.mediaType));
  for (const r of requestRows) known.add(candidateKey(r.tmdbId, r.mediaType));
  for (const r of voteRows) known.add(candidateKey(r.tmdbId, r.mediaType));
  return known;
}

// Titles the user sampled and demonstrably bailed on — see the ABANDON_*
// constants for the two guards (cumulative ratio, settle window). Only
// watched:false rows can matter here: any title with a watched:true row is
// already in the exclusion set and never becomes a candidate at all.
async function collectAbandonedTitleKeys(linkedServerUserIds: string[], now: number): Promise<Set<string>> {
  if (linkedServerUserIds.length === 0) return new Set();
  const groups = await prisma.playHistory.groupBy({
    by: ["tmdbId", "mediaType"],
    where: {
      mediaServerUserId: { in: linkedServerUserIds },
      watched: false,
      tmdbId: { not: null },
      mediaType: { not: null },
    },
    _sum: { playDuration: true },
    _max: { startedAt: true, duration: true },
    // Newest abandons first: under the scan cap it is the recent bails that
    // should win the slots — a title sampled years ago has aged out of mattering.
    orderBy: [{ _max: { startedAt: "desc" } }],
    take: ABANDON_SCAN_LIMIT,
  });

  const out = new Set<string>();
  for (const g of groups) {
    if (g.tmdbId == null || g.mediaType == null) continue;
    const runtime = g._max.duration;
    if (!runtime || runtime <= 0) continue; // no usable runtime — cannot judge a ratio
    if ((g._sum.playDuration ?? 0) / runtime >= ABANDON_MAX_CUMULATIVE_RATIO) continue; // split-watch in progress
    const lastTouch = g._max.startedAt?.getTime() ?? 0;
    if (now - lastTouch < ABANDON_SETTLE_MS) continue; // still settling
    out.add(candidateKey(g.tmdbId, g.mediaType));
  }
  return out;
}

async function buildExclusionSet(userId: string, linkedServerUserIds: string[], seeds: Seed[]): Promise<Set<string>> {
  const excluded = await collectKnownTitleKeys(userId, linkedServerUserIds);
  for (const s of seeds) {
    // REQUEST seeds do NOT fold themselves into the exclusion set. Request
    // exclusion is STATUS-BASED and lives in collectKnownTitleKeys alone
    // (PENDING/APPROVED/permanentlyDeclined out; AVAILABLE and re-requestable
    // DECLINED deliberately kept) — a blanket fold here would re-exclude the
    // kept classes the moment they became seeds, silently reversing that
    // decision. History/watchlist seeds still fold, though it is belt-and-
    // suspenders: both pools are wholly covered by collectKnownTitleKeys.
    if (s.source === "REQUEST") continue;
    excluded.add(candidateKey(s.tmdbId, s.mediaType));
  }
  return excluded;
}

export interface RecommendationComputation {
  candidates: RecommendationCandidate[];
  // Whether the answer above can be trusted as "this is what the user should see".
  //
  // getMovieSuggestions/getTVSuggestions swallow their own upstream failures and
  // return [] — deliberately, see the don't-cache-an-empty guard in tmdb.ts — so at
  // this layer a TMDB outage is indistinguishable from "this title genuinely has no
  // suggestions". A caller that REPLACES stored state must not treat an inconclusive
  // empty as authoritative, or one bad cron run wipes every user's recommendations
  // and reports success.
  //
  // True when there was nothing to compute from (no seeds — a legitimately empty
  // answer that SHOULD clear stale rows), or when at least one seed came back with
  // at least one raw suggestion (upstream is answering, so an empty result after
  // exclusion is real). False only when seeds existed and not one yielded a single
  // item — overwhelmingly an outage, and cheap to be wrong about: the caller just
  // keeps yesterday's recommendations for one more cycle.
  conclusive: boolean;
}

// Pure(ish) compute — no writes. Returns no candidates for a cold-start user (zero
// eligible seeds) without making any TMDB calls. Read `conclusive` before acting on
// an empty `candidates`: the two empties mean different things.
export async function computeRecommendationsForUser(userId: string): Promise<RecommendationComputation> {
  const linkedServerUserIds = await resolveLinkedMediaServerUserIds(userId);
  const seeds = await selectSeeds(userId, linkedServerUserIds);
  if (seeds.length === 0) {
    // Cold start: no history, no watchlist, no requests. Serve the fallback
    // shelf instead of the old conclusive empty. Exclusions still apply — a
    // seedless user can still have hidden titles, deletion votes, or an admin
    // blacklist to honour.
    const known = await collectKnownTitleKeys(userId, linkedServerUserIds);
    const fallback = await buildFallbackCandidates(known, new Set(), FALLBACK_SHELF_TARGET);
    return {
      candidates: fallback.candidates.map((c, i) => ({ ...c, rank: i })),
      // Pool fetch failed ⇒ inconclusive: keep yesterday's shelf (probably last
      // cycle's fallback rows) rather than wiping it over a transient outage.
      // Pool served but everything was excluded ⇒ a real, conclusive answer.
      conclusive: fallback.poolAvailable,
    };
  }

  const [excluded, abandoned] = await Promise.all([
    buildExclusionSet(userId, linkedServerUserIds, seeds),
    collectAbandonedTitleKeys(linkedServerUserIds, Date.now()),
  ]);

  // SUGGESTIONS_CACHE_MAX (not the 18-item rail default) — the tail of each
  // seed's list is exactly what lets the ranked set reach 200. Same cache row
  // and same request count as the rail; only the slice differs.
  const suggestionResults = await settleLimit(seeds, SEED_CONCURRENCY, (seed) =>
    seed.mediaType === "MOVIE"
      ? getMovieSuggestions(seed.tmdbId, SUGGESTIONS_CACHE_MAX)
      : getTVSuggestions(seed.tmdbId, SUGGESTIONS_CACHE_MAX),
  );

  // Counted BEFORE exclusion: a user who has already watched every suggestion is a
  // conclusive empty (clear their stale rows), whereas zero items arriving at all is
  // the outage case. Filtering first would collapse the two back together.
  let rawSuggestions = 0;

  // reasonWeight, language, voteCount and contributions are bookkeeping — the
  // first picks the strongest seed, the second feeds the language profile, the
  // third lets the quality prior's TMDB term see the vote count it gates on,
  // and the fourth holds each seed's contribution until the corroboration
  // decay-sum below collapses them into the score. All are dropped before the
  // candidates are returned; none has a column. voteCount earned its place by
  // being ABSENT: applyQualityPrior used to rebuild TmdbMedia without it, so
  // the (voteCount >= 50) gate read 0 for every candidate and TMDB's own score
  // silently never participated in the prior at all.
  const scored = new Map<string, RecommendationCandidate & { reasonWeight: number; language?: string; voteCount: number; contributions: number[] }>();
  // Weighted language tally, accumulated in the same pass that scores.
  const languageWeight = new Map<string, number>();
  let totalLanguageWeight = 0;
  seeds.forEach((seed, i) => {
    const result = suggestionResults[i];
    if (result.status !== "fulfilled") return;
    // position is the index within THIS seed's suggestion list, so it has to be
    // counted over the raw list — not over the survivors of the exclusion filter
    // below, which would silently promote every item sitting behind a title the
    // user had already watched.
    let position = -1;
    for (const item of result.value) {
      position++;
      rawSuggestions++;
      const mediaType = toDbMediaType(item.mediaType);
      const key = candidateKey(item.id, mediaType);
      if (excluded.has(key)) continue;
      const contribution = seed.weight * positionFactor(position);

      // Tallied AFTER the exclusion check above, deliberately: excluded titles
      // are ones the viewer has already watched or listed, so counting them
      // would shape the profile around a back catalogue that can never appear
      // in the output anyway. The profile describes the CANDIDATE pool.
      if (item.originalLanguage) {
        languageWeight.set(item.originalLanguage, (languageWeight.get(item.originalLanguage) ?? 0) + contribution);
        totalLanguageWeight += contribution;
      }

      const existing = scored.get(key);
      if (existing) {
        existing.contributions.push(contribution);
        existing.seedCount++;
        // Keep the STRONGEST contribution as the reason, not the first one
        // encountered — seeds are no longer visited in weight order at all, so
        // first-wins would name an essentially arbitrary title. Comparing
        // CONTRIBUTION rather than raw seed weight is deliberate: a slightly
        // weaker seed that ranks this title first is a better explanation than a
        // strong seed that had it 40th. Ties keep the incumbent.
        if (contribution > existing.reasonWeight) {
          existing.reasonWeight = contribution;
          existing.reasonTmdbId = seed.tmdbId;
          existing.reasonTitle = seed.title;
          existing.reasonMediaType = seed.mediaType;
          existing.reasonSource = seed.source;
        }
        continue;
      }
      scored.set(key, {
        tmdbId: item.id,
        mediaType,
        title: item.title,
        overview: item.overview || null,
        posterPath: item.posterPath,
        backdropPath: item.backdropPath,
        releaseDate: item.releaseDate,
        voteAverage: item.voteAverage,
        score: contribution,
        rank: 0,
        reasonTmdbId: seed.tmdbId,
        reasonTitle: seed.title,
        reasonMediaType: seed.mediaType,
        reasonSource: seed.source,
        reasonWeight: contribution,
        seedCount: 1,
        language: item.originalLanguage ?? undefined,
        voteCount: item.voteCount ?? 0,
        contributions: [contribution],
      });
    }
  });

  // ── Corroboration decay-sum ─────────────────────────────────────────────
  // Collapse each candidate's contribution list into its score: strongest
  // first, the i-th scaled by DECAY^i, bounding total amplification at 4x the
  // best single contribution (see CORROBORATION_DECAY). Runs before every
  // multiplier below — they scale the bounded score, not the raw sum.
  for (const candidate of scored.values()) {
    candidate.contributions.sort((a, b) => b - a);
    let sum = 0;
    let factor = 1;
    for (const c of candidate.contributions) {
      sum += c * factor;
      factor *= CORROBORATION_DECAY;
    }
    candidate.score = sum;
  }

  // ── Language de-emphasis ────────────────────────────────────────────────
  // Applied after the accumulation pass because the profile is only known once
  // every contribution has been counted. A candidate with no language recorded
  // is left alone (factor 1.0) — missing metadata is not evidence.
  if (totalLanguageWeight > 0) {
    for (const candidate of scored.values()) {
      if (!candidate.language) continue;
      const share = (languageWeight.get(candidate.language) ?? 0) / totalLanguageWeight;
      candidate.score *= languageFactor(share);
    }
  }

  // ── Abandoned-play dampening ────────────────────────────────────────────
  // A per-title multiplier, never a neighborhood effect (see ABANDON_DAMP).
  if (abandoned.size > 0) {
    for (const candidate of scored.values()) {
      if (abandoned.has(candidateKey(candidate.tmdbId, candidate.mediaType))) {
        candidate.score *= ABANDON_DAMP;
      }
    }
  }

  const byRelevance = [...scored.values()]
    // Scores come from a continuous product of factors, so exact ties are rare
    // — but when they happen, break by community rating rather than by Map
    // insertion order, which is an artefact of seed iteration.
    .sort((a, b) => b.score - a.score || b.voteAverage - a.voteAverage);

  // ── Quality prior ───────────────────────────────────────────────────────
  // Only the shortlist is rated: rating every candidate would mean thousands of
  // lookups per user, and anything below the shortlist was never going to be
  // stored anyway. Relevance gates, quality refines.
  const shortlist = byRelevance.slice(0, RATING_SHORTLIST);
  await applyQualityPrior(shortlist);

  const ranked = shortlist
    .sort((a, b) => b.score - a.score || b.voteAverage - a.voteAverage)
    .slice(0, MAX_STORED_RECOMMENDATIONS_PER_USER)
    .map(
      ({ reasonWeight: _reasonWeight, language: _language, voteCount: _voteCount, contributions: _contributions, ...c }, i): RecommendationCandidate => ({ ...c, rank: i }),
    );

  // Thin shelf (few seeds, or a viewer who has watched most of their
  // neighborhood): top up toward the fallback target, fallback rows ranked
  // strictly AFTER every real pick. A pool failure here just skips the top-up
  // — the real candidates stand, and conclusive keeps its meaning from the
  // suggestion fan-out above, never from the fallback.
  if (ranked.length < FALLBACK_SHELF_TARGET) {
    const taken = new Set(ranked.map((c) => candidateKey(c.tmdbId, c.mediaType)));
    const fallback = await buildFallbackCandidates(excluded, taken, FALLBACK_SHELF_TARGET - ranked.length);
    for (const c of fallback.candidates) ranked.push({ ...c, rank: ranked.length });
  }

  return { candidates: ranked, conclusive: rawSuggestions > 0 };
}

interface FallbackPoolResult {
  candidates: RecommendationCandidate[];
  // False when the trending/popular reads themselves failed — the caller keeps
  // yesterday's shelf rather than wiping it over a transient outage. True with
  // zero candidates is a REAL answer (everything trending is excluded/taken).
  poolAvailable: boolean;
}

// Builds up to `slots` fallback rows from the trending/popular caches, skipping
// anything the user already knows (excludedKeys) or the shelf already holds
// (takenKeys). Rows come back quality-ordered but with score 0 — the engine
// has NO relevance opinion on them, and a zero score keeps that fact in the
// data rather than inventing a comparable number.
async function buildFallbackCandidates(
  excludedKeys: Set<string>,
  takenKeys: Set<string>,
  slots: number,
): Promise<FallbackPoolResult> {
  if (slots <= 0) return { candidates: [], poolAvailable: true };

  let pool: TmdbMedia[];
  try {
    const [trending, popMovies, popTV] = await Promise.all([getTrending(), getPopularMovies(), getPopularTV()]);
    // Trending first: it is the freshest signal, and the dedupe below keeps the
    // first copy, so a title on both lists reads as trending.
    pool = [...trending, ...popMovies, ...popTV];
  } catch (err) {
    console.warn("[recommendations] fallback pool unavailable; leaving the shelf as-is:", err);
    return { candidates: [], poolAvailable: false };
  }
  if (pool.length === 0) return { candidates: [], poolAvailable: false };

  const seen = new Set<string>();
  const picked: (RecommendationCandidate & { language?: string; voteCount: number })[] = [];
  for (const item of pool) {
    const mediaType = toDbMediaType(item.mediaType);
    const key = candidateKey(item.id, mediaType);
    if (seen.has(key) || excludedKeys.has(key) || takenKeys.has(key)) continue;
    seen.add(key);
    picked.push({
      tmdbId: item.id,
      mediaType,
      title: item.title,
      overview: item.overview || null,
      posterPath: item.posterPath,
      backdropPath: item.backdropPath,
      releaseDate: item.releaseDate,
      voteAverage: item.voteAverage,
      // Transient ordering seed: pool position, gently decayed, so the quality
      // prior refines the trending order instead of replacing it. Zeroed below
      // before the rows leave this function.
      score: 1 / (1 + picked.length / 20),
      rank: 0,
      reasonTmdbId: null,
      reasonTitle: null,
      reasonMediaType: null,
      reasonSource: "TRENDING",
      seedCount: 0,
      voteCount: item.voteCount ?? 0,
    });
    // Overfetch 2x before the quality sort so a badly-rated title near the top
    // of trending can actually be out-ranked instead of being locked in.
    if (picked.length >= slots * 2) break;
  }

  await applyQualityPrior(picked);
  picked.sort((a, b) => b.score - a.score || b.voteAverage - a.voteAverage);

  return {
    candidates: picked.slice(0, slots).map(({ voteCount: _vc, language: _l, ...c }) => ({ ...c, score: 0 })),
    poolAvailable: true,
  };
}

// IMDb vote counts arrive as "12345" from MDBList and "1,234,567" from OMDB —
// tolerate both. Null when absent or unparseable; zero votes reads as absent
// (a count of 0 alongside a rating is provider noise, not evidence).
function parseVoteCount(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const n = parseInt(raw.replace(/[,\s]/g, ""), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export interface QualityVerdict {
  // Weighted mean over the sources that answered, 0..1.
  quality: number;
  // Total source weight behind that mean — what the confidence scaling in
  // applyQualityPrior feeds on. IMDb at full vote depth alone contributes ~3;
  // a lone Trakt percentage 0.5.
  evidence: number;
}

// Normalizes whatever rating sources answered for a title into one weighted
// 0..1 figure plus the evidence behind it. Every source is optional and
// independent — the mean spans only those PRESENT, so a title carrying only
// IMDb is judged on IMDb rather than being dragged toward zero by the absent
// ones. Weights are the IMDB_/CRITIC_/COMMUNITY_/SECONDARY_/TMDB_ constants
// above: IMDb anchors when its vote depth backs it, everything else orbits.
//
// TMDB's own vote is included but only when the title has enough votes to mean
// anything; a 10.0 from four people is noise, and it is exactly the kind of
// obscure title the suggestion tail is full of.
export function qualityScoreOf(media: TmdbMedia): QualityVerdict | null {
  let weighted = 0;
  let evidence = 0;
  const add = (value: number, weight: number) => {
    weighted += value * weight;
    evidence += weight;
  };

  const imdb = parseFloat(media.imdbRating ?? "");
  if (Number.isFinite(imdb)) {
    const votes = parseVoteCount(media.imdbVotes);
    const weight = votes === null
      ? IMDB_QUALITY_WEIGHT_UNKNOWN_VOTES
      : IMDB_QUALITY_WEIGHT_MAX * (votes / (votes + IMDB_QUALITY_VOTE_PIVOT));
    add(Math.min(1, imdb / 10), weight);
  }

  // "84%" and "84" both appear depending on source.
  const rt = parseFloat((media.rottenTomatoes ?? "").replace("%", ""));
  if (Number.isFinite(rt)) add(Math.min(1, rt / 100), CRITIC_QUALITY_WEIGHT);

  const mc = parseFloat((media.metacritic ?? "").replace(/\/100$/, ""));
  if (Number.isFinite(mc)) add(Math.min(1, mc / 100), CRITIC_QUALITY_WEIGHT);

  // Letterboxd is out of 5; its site-wide mean sits near 3.25, which lands on
  // QUALITY_NEUTRAL under this scaling — no per-source recentering needed.
  const lb = parseFloat(media.letterboxdRating ?? "");
  if (Number.isFinite(lb)) add(Math.min(1, lb / 5), COMMUNITY_QUALITY_WEIGHT);

  const mal = parseFloat(media.malRating ?? "");
  if (Number.isFinite(mal)) add(Math.min(1, mal / 10), COMMUNITY_QUALITY_WEIGHT);

  const trakt = parseFloat((media.traktRating ?? "").replace("%", ""));
  if (Number.isFinite(trakt)) add(Math.min(1, trakt / 100), SECONDARY_QUALITY_WEIGHT);

  const audience = parseFloat((media.rtAudienceScore ?? "").replace("%", ""));
  if (Number.isFinite(audience)) add(Math.min(1, audience / 100), SECONDARY_QUALITY_WEIGHT);

  if (media.voteAverage > 0 && (media.voteCount ?? 0) >= MIN_TMDB_VOTES_FOR_QUALITY) {
    const votes = media.voteCount ?? 0;
    add(
      Math.min(1, media.voteAverage / 10),
      TMDB_QUALITY_WEIGHT_MAX * (votes / (votes + TMDB_QUALITY_VOTE_PIVOT)),
    );
  }

  if (evidence <= 0) return null;
  return { quality: weighted / evidence, evidence };
}

// Multiplies each shortlisted candidate's score by how well the rating sources
// think of it. Mutates in place; never throws — a ratings outage must degrade
// to "no quality opinion", not fail the whole recommendation run.
async function applyQualityPrior(shortlist: (RecommendationCandidate & { language?: string; voteCount: number })[]): Promise<void> {
  if (shortlist.length === 0) return;

  let rated: TmdbMedia[];
  try {
    // blocking:true keeps the work inline. The non-blocking path defers to
    // Next's after(), which belongs to a request lifecycle — this runs in a
    // cron fan-out over many users, where a detached background fetch per user
    // has nothing sensible to attach to. attachRatingsUnified handles its own
    // quota lockouts and caps the OMDB fallback internally.
    rated = await attachRatingsUnified(
      shortlist.map((c) => ({
        id: c.tmdbId,
        mediaType: toTmdbMediaType(c.mediaType),
        title: c.title,
        overview: c.overview ?? "",
        posterPath: c.posterPath,
        backdropPath: c.backdropPath,
        releaseDate: c.releaseDate,
        releaseYear: c.releaseDate?.slice(0, 4) ?? null,
        voteAverage: c.voteAverage,
        voteCount: c.voteCount,
      })),
      { blocking: true },
    );
  } catch (err) {
    console.warn("[recommendations] ratings lookup failed; ranking on relevance alone:", err);
    return;
  }

  const byKey = new Map(rated.map((m) => [`${m.id}:${toDbMediaType(m.mediaType)}`, m]));
  for (const candidate of shortlist) {
    const media = byKey.get(candidateKey(candidate.tmdbId, candidate.mediaType));
    if (!media) continue;
    const verdict = qualityScoreOf(media);
    if (verdict === null) {
      // Nothing answered. For a title with a real audience that stays neutral —
      // "unrated" usually means the providers just don't cover it. But a null
      // verdict on a title ALMOST NOBODY HAS RATED ANYWHERE (under the same
      // 50-vote bar the TMDB term uses) is the suggestion tail's obscure junk,
      // and it used to keep its full relevance score while properly-rated 6.0
      // titles were pulled DOWN — mediocre-but-known lost to unknown. The damp
      // is bounded and mild — 0.9 sits inside the band a mediocre-rated title
      // lands in, so obscurity reads as "probably middling", never as
      // known-bad — and it sits after the outage catch so a ratings failure
      // never becomes a penalty.
      if (candidate.voteCount < MIN_TMDB_VOTES_FOR_QUALITY) candidate.score *= OBSCURITY_DAMP;
      continue;
    }
    // Confidence saturates with evidence: one full-weight source (a critic
    // aggregate) applies the prior at half its ceiling; deep-voted IMDb plus
    // the critics push it toward ~0.85 of it; a lone thin source stays a
    // nudge. This is what lets the ceiling above sit higher than the old flat
    // weight without handing single sources a bigger yank than they ever had.
    const confidence = verdict.evidence / (verdict.evidence + QUALITY_CONFIDENCE_PIVOT);
    candidate.score *= 1 + QUALITY_WEIGHT * confidence * (verdict.quality - QUALITY_NEUTRAL);
  }
}

// Who the cron bothers computing for. authSessions.lastSeenAt (not a fresh
// lastActiveAt column, and not PlayHistory recency — a rich-but-dormant
// account shouldn't burn TMDB calls every cycle) tracks genuine recent app use.
async function getActiveUserIds(): Promise<string[]> {
  const cutoff = new Date(Date.now() - ACTIVE_USER_WINDOW_MS);
  const rows = await prisma.user.findMany({
    where: {
      deactivatedAt: null,
      purgedAt: null,
      authSessions: { some: { lastSeenAt: { gte: cutoff } } },
    },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

export async function warmRecommendationsCache(): Promise<{
  usersEligible: number;
  usersUpdated: number;
  usersSkipped: number;
  usersFailed: number;
  candidatesWritten: number;
}> {
  const userIds = await getActiveUserIds();

  // One transaction PER USER, not one spanning all users — bounds the blast
  // radius of a single user's failure and keeps any one lock/timeout small.
  const results = await settleLimit(userIds, USER_CONCURRENCY, async (userId) => {
    const { candidates, conclusive } = await computeRecommendationsForUser(userId);
    // NEVER let an inconclusive run replace good rows with nothing. The write below
    // is delete-then-insert, so an empty `candidates` produced by a TMDB outage
    // would clear the user's shelf — and because the compute RESOLVES rather than
    // throws, it would be counted as a successful update. Keep the stale set and
    // recompute next cycle.
    if (!conclusive) return null;
    await prisma.$transaction(
      async (tx) => {
        await tx.userRecommendation.deleteMany({ where: { userId } });
        if (candidates.length > 0) {
          await batchCreateMany(
            tx.userRecommendation,
            candidates.map((c) => ({ ...c, userId })),
          );
        }
      },
      { timeout: BATCH_TX_TIMEOUT },
    );
    return candidates.length;
  });

  let usersUpdated = 0;
  let usersSkipped = 0;
  let usersFailed = 0;
  let candidatesWritten = 0;
  for (const r of results) {
    if (r.status === "fulfilled") {
      if (r.value === null) {
        usersSkipped++;
        continue;
      }
      usersUpdated++;
      candidatesWritten += r.value;
    } else {
      usersFailed++;
      console.error("[recommendations] per-user compute/write failed:", r.reason);
    }
  }
  if (usersSkipped > 0) {
    console.warn(
      `[recommendations] kept the existing recommendations for ${usersSkipped}/${userIds.length} user(s) — ` +
        "they had seeds but no suggestions came back at all (most likely a TMDB outage). Nothing was cleared.",
    );
  }
  return { usersEligible: userIds.length, usersUpdated, usersSkipped, usersFailed, candidatesWritten };
}

function rowToTmdbMedia(row: {
  tmdbId: number;
  mediaType: MediaType;
  title: string;
  overview: string | null;
  posterPath: string | null;
  backdropPath: string | null;
  releaseDate: string | null;
  voteAverage: number;
  reasonTmdbId: number | null;
  reasonTitle: string | null;
  reasonMediaType: MediaType | null;
  reasonSource: RecommendationSeed | null;
  seedCount: number;
}): TmdbMedia {
  return {
    id: row.tmdbId,
    mediaType: toTmdbMediaType(row.mediaType),
    title: row.title,
    overview: row.overview ?? "",
    posterPath: row.posterPath,
    backdropPath: row.backdropPath,
    releaseDate: row.releaseDate,
    releaseYear: row.releaseDate?.slice(0, 4) ?? null,
    voteAverage: row.voteAverage,
    // All four reason columns are written together or not at all, so one
    // null-check covers the whole object. Rows predating the columns simply
    // carry no reason and the UI omits the line — they heal on the next cron
    // run. Fallback rows (reasonSource TRENDING, other three null) rely on
    // this same gate to never grow a fabricated reason line.
    ...(row.reasonTmdbId != null && row.reasonTitle != null && row.reasonMediaType != null && row.reasonSource != null
      ? {
          recommendedBecause: {
            tmdbId: row.reasonTmdbId,
            title: row.reasonTitle,
            mediaType: toTmdbMediaType(row.reasonMediaType),
            source: row.reasonSource,
            seedCount: row.seedCount,
          },
        }
      : {}),
    ...(row.reasonSource === "TRENDING" ? { fromTrendingFallback: true } : {}),
  };
}

export interface RecommendationSummary {
  // When THIS user's set was last rebuilt. Read per-user rather than from the
  // global `cron:lastRun:recommendations` Setting because the cron deliberately
  // skips users (inconclusive TMDB run, or dormant and out of the active
  // cohort) — the global timestamp would claim a refresh they never got.
  computedAt: Date | null;
  // How many DISTINCT seed titles actually produced a visible pick, split by
  // pool. Counted off the stored reasons rather than by re-running selectSeeds:
  // it is one small per-user query instead of three, and it answers the more
  // honest question — not "what did we feed the engine" but "what did the
  // engine actually get something out of". Fallback rows never count: their
  // reasonTmdbId is null, so the groupBy's non-null predicate drops them.
  watchHistorySeeds: number;
  watchlistSeeds: number;
  requestSeeds: number;
}

export async function getRecommendationSummary(userId: string): Promise<RecommendationSummary> {
  const [agg, seedRows] = await Promise.all([
    prisma.userRecommendation.aggregate({ where: { userId }, _max: { computedAt: true } }),
    prisma.userRecommendation.groupBy({
      by: ["reasonSource", "reasonTmdbId"],
      where: { userId, reasonSource: { not: null }, reasonTmdbId: { not: null } },
    }),
  ]);

  let watchHistorySeeds = 0;
  let watchlistSeeds = 0;
  let requestSeeds = 0;
  for (const row of seedRows) {
    if (row.reasonSource === "WATCHLIST") watchlistSeeds++;
    else if (row.reasonSource === "WATCH_HISTORY") watchHistorySeeds++;
    else if (row.reasonSource === "REQUEST") requestSeeds++;
  }

  return { computedAt: agg._max.computedAt, watchHistorySeeds, watchlistSeeds, requestSeeds };
}

// Read path — called directly by home/route.ts and page.tsx. Re-filters the
// cache against CURRENT WatchlistItem + watched-PlayHistory state so drift
// between a 6-12h cron cycle and the page load never surfaces something the
// user has since watchlisted or watched. HiddenItem needs no handling here —
// attachAllAvailability already removes it downstream for every rail.
export async function getUserRecommendations(userId: string): Promise<TmdbMedia[]> {
  const cached = await prisma.userRecommendation.findMany({
    where: { userId },
    orderBy: { rank: "asc" },
  });
  if (cached.length === 0) return [];

  const linkedServerUserIds = await resolveLinkedMediaServerUserIds(userId);
  // The SAME reader the compute-time exclusion uses (collectKnownTitleKeys), so
  // anything the user has acted on since the last cron — watched, watchlisted,
  // hidden, requested, voted to delete, or admin-blacklisted — vacates its slot
  // at the next render instead of squatting until the next 12h cycle.
  const currentlyKnown = await collectKnownTitleKeys(userId, linkedServerUserIds);

  // Tier is assigned over the SERVED set, so a shelf whose top pick has since
  // been watched promotes the next title into the top band rather than leaving
  // a gap where a chip used to be.
  //
  // Serve at most MAX_SERVED_RECOMMENDATIONS of the survivors: the store holds
  // a deeper rated reserve (MAX_STORED_RECOMMENDATIONS_PER_USER) precisely so
  // drift-excluded rows BACKFILL from ranks below the serve line instantly —
  // but the slice must stay, or every render's availability/ratings enrichment
  // fan-out grows by the reserve's size for no visible benefit.
  const surviving = cached.filter((row) => !currentlyKnown.has(candidateKey(row.tmdbId, row.mediaType)));
  const served = surviving.slice(0, MAX_SERVED_RECOMMENDATIONS);

  // Match tiers are computed over the REAL picks only. Fallback rows are
  // stored strictly after every real pick (rank order), so the real rows are
  // a prefix of `served` and indexes line up — but the denominator must be the
  // real count, or a mostly-fallback shelf would hand "Top match" chips to
  // titles picked for everyone, eroding the chip's meaning everywhere.
  const realCount = served.filter((row) => row.reasonSource !== "TRENDING").length;
  return served.map((row, i) => {
    const media = rowToTmdbMedia(row);
    const tier = row.reasonSource === "TRENDING" ? undefined : matchTierFor(i, realCount);
    return tier ? { ...media, matchTier: tier } : media;
  });
}
