import type { TmdbMedia } from "./tmdb-types";

// The "For You" engine's QUALITY PRIOR, extracted whole from recommendations.ts
// so the server-wide graph builder (recommendation-graph.ts) and the per-user
// engine can share one definition. Nothing here touches Prisma, the network, or
// `server-only` — it is a pure function of a TmdbMedia's rating fields, which is
// what lets the graph precompute a verdict once per TITLE instead of once per
// title per user.

// ── Quality prior ──────────────────────────────────────────────────────────
// Relevance ("this resembles what you watch") is not the same as worth
// watching. After relevance ranking, the top slice is re-weighted by what the
// rating sources say — IMDb/RT/Metacritic/Trakt/Letterboxd/MAL via MDBList,
// with OMDB filling gaps, plus TMDB's own score which every candidate already
// carries.
//
// EVIDENCE-WEIGHTED, IMDb-led. Each source has a weight, and the quality figure
// is the weighted average. IMDb's weight grows with its vote count (it has the
// most voters of any source, so it anchors the blend). The multiplier's
// strength also grows with the total weight behind the verdict: IMDb with many
// votes plus the critic scores pulls hard, while one thin source (say, a lone
// Trakt percentage) barely moves anything. An unweighted average would let
// that lone source re-rank a title as hard as IMDb + RT + Metacritic agreeing.
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

// Maximum strength of the prior. It is never used alone: the real strength is
// QUALITY_WEIGHT × confidence, where confidence = evidence/(evidence + PIVOT)
// climbs toward 1 as more source weight piles up. IMDb with many votes plus the
// critic scores lands around 0.75; a lone thin source around 0.2-0.3. Dropping
// the confidence term would let a single source swing a title too hard.
export const QUALITY_WEIGHT = 0.9;
export const QUALITY_NEUTRAL = 0.65;
export const QUALITY_CONFIDENCE_PIVOT = 1.0;
export const OBSCURITY_DAMP = 0.9;
// TMDB's score is the only one every candidate carries, so it would otherwise
// dominate the mean — but on a thinly-voted title it is noise (a 10.0 from four
// people), and the suggestion tail is full of exactly those. Below this many
// votes TMDB abstains and the title is judged on whatever else answered.
export const MIN_TMDB_VOTES_FOR_QUALITY = 50;

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
  // qualityMultiplier feeds on. IMDb at full vote depth alone contributes ~3;
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

// Re-blends TMDB's own score into a verdict that was computed WITHOUT it.
//
// Every other source in the prior is a fact about the title that is the same
// for everyone and can be stored once (recommendation-graph.ts does exactly
// that). TMDB's term cannot: qualityScoreOf gates it on a vote count, and the
// count travels with the candidate row the engine is scoring — the graph would
// have to guess it at write time. So the stored verdict is TMDB-free and this
// folds the term back in at read time, weighted identically to the inline
// version in qualityScoreOf. A title that fails the vote bar is returned
// untouched, which is precisely "TMDB abstains".
export function withTmdbTerm(
  verdict: QualityVerdict | null,
  voteAverage: number,
  voteCount: number,
): QualityVerdict | null {
  if (!(voteAverage > 0 && voteCount >= MIN_TMDB_VOTES_FOR_QUALITY)) return verdict;
  const weight = TMDB_QUALITY_WEIGHT_MAX * (voteCount / (voteCount + TMDB_QUALITY_VOTE_PIVOT));
  const value = Math.min(1, voteAverage / 10);
  if (verdict === null) return { quality: value, evidence: weight };
  const evidence = verdict.evidence + weight;
  return { quality: (verdict.quality * verdict.evidence + value * weight) / evidence, evidence };
}

// The score multiplier a verdict earns. Kept as ONE shared function so every
// caller applies stored verdicts the same way.
//
// A null verdict means no provider answered. For a title with a real audience
// that stays neutral (1.0): "unrated" usually just means the providers don't
// cover it. But if almost nobody has rated it anywhere (under the same 50-vote
// bar the TMDB term uses), it is likely obscure filler from the end of a
// suggestion list, and without a penalty it would outrank known 6/10 titles
// that the prior pulled down. The penalty is mild: 0.9 is about where a
// middling title lands, so "obscure" reads as "probably average", not "bad".
export function qualityMultiplier(verdict: QualityVerdict | null, tmdbVoteCount: number): number {
  if (verdict === null) {
    return tmdbVoteCount < MIN_TMDB_VOTES_FOR_QUALITY ? OBSCURITY_DAMP : 1;
  }
  // Confidence grows with evidence: one full-weight source (a critic score)
  // applies the prior at half strength; IMDb with many votes plus the critics
  // reach ~0.85 of it; a lone thin source stays a small nudge.
  const confidence = verdict.evidence / (verdict.evidence + QUALITY_CONFIDENCE_PIVOT);
  return 1 + QUALITY_WEIGHT * confidence * (verdict.quality - QUALITY_NEUTRAL);
}
