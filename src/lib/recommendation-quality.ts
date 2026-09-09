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

// Ceiling strength of the prior. Never applied bare: the effective strength is
// QUALITY_WEIGHT × confidence, where confidence = evidence/(evidence + PIVOT)
// saturates toward 1 as source weight accumulates. Deep-voted IMDb plus the
// critic aggregates lands around 0.75 effective — a stronger pull than the old
// flat 0.5, which is the point of the rework — while a lone thin source gets
// ~0.2-0.3, weaker than it used to wield. Raising the ceiling without the
// confidence term would resurrect exactly the single-source yank the term
// exists to prevent.
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

// The score multiplier a verdict earns. ONE definition, shared by the per-user
// engine and by anything that wants to reason about a precomputed verdict —
// the two used to be the same inline expression in one place, and splitting the
// storage of a verdict from its application is exactly how they would drift.
//
// A null verdict means not one provider answered. For a title with a real
// audience that stays neutral — "unrated" usually means the providers just
// don't cover it. But a null verdict on a title ALMOST NOBODY HAS RATED
// ANYWHERE (under the same 50-vote bar the TMDB term uses) is the suggestion
// tail's obscure junk, and it used to keep its full relevance score while
// properly-rated 6.0 titles were pulled DOWN — mediocre-but-known lost to
// unknown. The damp is bounded and mild — 0.9 sits inside the band a mediocre-
// rated title lands in, so obscurity reads as "probably middling", never as
// known-bad.
export function qualityMultiplier(verdict: QualityVerdict | null, tmdbVoteCount: number): number {
  if (verdict === null) {
    return tmdbVoteCount < MIN_TMDB_VOTES_FOR_QUALITY ? OBSCURITY_DAMP : 1;
  }
  // Confidence saturates with evidence: one full-weight source (a critic
  // aggregate) applies the prior at half its ceiling; deep-voted IMDb plus the
  // critics push it toward ~0.85 of it; a lone thin source stays a nudge. This
  // is what lets the ceiling above sit higher than the old flat weight without
  // handing single sources a bigger yank than they ever had.
  const confidence = verdict.evidence / (verdict.evidence + QUALITY_CONFIDENCE_PIVOT);
  return 1 + QUALITY_WEIGHT * confidence * (verdict.quality - QUALITY_NEUTRAL);
}
