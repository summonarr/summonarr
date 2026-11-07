// Pure scoring for the Plex fix-match picker (candidates route): how well each
// /matches result fits the TMDB id the admin is correcting to, and which one the
// picker marks "Suggested". Zero imports so the rules can be tested alone.

export type CandidateMatch = "exact" | "strong" | "likely" | "possible" | "wrong" | "unknown";

/** Sort rank of each level, best first. */
export const CANDIDATE_LEVEL_ORDER: Record<CandidateMatch, number> = { exact: 0, strong: 1, likely: 2, possible: 3, unknown: 4, wrong: 5 };

// Long enough for any real title; bounds the O(m·n) edit distance against a
// media server that answers with an absurd name.
const MAX_TITLE_CODE_POINTS = 256;

// Unicode-aware: accents are folded (NFKD, marks dropped) and every script's
// letters and digits are kept. An [a-z0-9] filter emptied every CJK, Cyrillic or
// Greek title, and two empty strings compared equal.
function titleCodePoints(s: string): string[] {
  const n = s
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(n).slice(0, MAX_TITLE_CODE_POINTS);
}

/** 0-100 similarity of two titles via normalized Levenshtein edit distance (per code point). */
export function titleSimilarity(a: string, b: string): number {
  const na = titleCodePoints(a);
  const nb = titleCodePoints(b);
  // Nothing comparable on a side is no evidence at all — never a match.
  if (na.length === 0 || nb.length === 0) return 0;
  const m = na.length;
  const n = nb.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let cur = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      cur[j] = na[i - 1] === nb[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j], cur[j - 1], prev[j - 1]);
    }
    [prev, cur] = [cur, prev];
  }
  return Math.round((1 - prev[n] / Math.max(m, n)) * 100);
}

export type CandidateFacts = {
  tmdbId: string | null; imdbId: string | null; name: string; year: number | null;
  tmdbTitle: string | null; tmdbRuntime: number | null; tmdbGenres: string[]; radarrConfirmed: boolean;
};
export type TargetFacts = {
  tmdbId: number; imdbId: string; title: string; year: string;
  runtime: number | null; genres: string[];
};

// Classifies a Plex match candidate against the target (exact/strong/…/wrong)
// from provider-id agreement plus a weighted title/year/runtime/genre score.
export function assessCandidate(
  candidate: CandidateFacts,
  target: TargetFacts,
): { matchLevel: CandidateMatch; confidence: number; titleSimilarity: number } {
  const ts = titleSimilarity(candidate.tmdbTitle ?? candidate.name, target.title);

  if (
    candidate.radarrConfirmed ||
    (candidate.tmdbId && candidate.tmdbId === String(target.tmdbId)) ||
    (candidate.imdbId && candidate.imdbId === target.imdbId && target.imdbId)
  ) {
    return { matchLevel: "exact", confidence: 100, titleSimilarity: ts };
  }

  if (candidate.imdbId && target.imdbId && candidate.imdbId !== target.imdbId) {
    return { matchLevel: "wrong", confidence: 0, titleSimilarity: ts };
  }

  let score = 0;

  score += Math.round(ts * 0.4);

  const cYear = candidate.year;
  const tYear = parseInt(target.year, 10);
  if (cYear && tYear) {
    if (cYear === tYear) score += 20;
    else if (Math.abs(cYear - tYear) === 1) score += 10;
    else if (Math.abs(cYear - tYear) === 2) score += 5;
  }

  if (candidate.tmdbRuntime && target.runtime) {
    const diff = Math.abs(candidate.tmdbRuntime - target.runtime);
    if (diff <= 2) score += 15;
    else if (diff <= 5) score += 12;
    else if (diff <= 10) score += 7;
    else if (diff <= 20) score += 3;
  }

  if (candidate.tmdbGenres.length && target.genres.length) {
    const intersection = candidate.tmdbGenres.filter((g) => target.genres.includes(g)).length;
    const union = new Set([...candidate.tmdbGenres, ...target.genres]).size;
    score += Math.round((intersection / union) * 15);
  }

  if (candidate.tmdbId && candidate.tmdbId !== String(target.tmdbId)) {
    score = Math.min(score, 40);
  }

  let matchLevel: CandidateMatch;
  if (score >= 75)      matchLevel = "strong";
  else if (score >= 55) matchLevel = "likely";
  else if (score >= 30) matchLevel = "possible";
  else                  matchLevel = "unknown";

  return { matchLevel, confidence: score, titleSimilarity: ts };
}

/** Best level first, then highest confidence. */
export function compareCandidates(
  a: { matchLevel: CandidateMatch; confidence: number },
  b: { matchLevel: CandidateMatch; confidence: number },
): number {
  const lo = CANDIDATE_LEVEL_ORDER[a.matchLevel] - CANDIDATE_LEVEL_ORDER[b.matchLevel];
  return lo !== 0 ? lo : b.confidence - a.confidence;
}

/**
 * The guid the picker marks "Suggested": the first IMDb-GUID search hit unless a
 * better-ranked candidate exists, else the best-ranked one. A candidate the
 * scorer called "wrong" is never suggested — when every candidate is wrong,
 * nothing is.
 */
export function pickSuggestedGuid(
  sorted: ReadonlyArray<{ guid: string; matchLevel: CandidateMatch }>,
  firstImdbGuid: string | null,
): string | null {
  const first = firstImdbGuid ? sorted.find((c) => c.guid === firstImdbGuid) : undefined;
  const initial = first && first.matchLevel !== "wrong" ? first : undefined;
  const top = sorted.find((c) => c.matchLevel !== "wrong");
  if (top && initial && CANDIDATE_LEVEL_ORDER[top.matchLevel] < CANDIDATE_LEVEL_ORDER[initial.matchLevel]) return top.guid;
  return initial?.guid ?? top?.guid ?? null;
}
