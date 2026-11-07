// Play-method mix behind the Activity stream-type bars. The three methods the
// UI names are counted by name; every other method the server recorded (a null
// method reads "Unknown", mostly older Jellyfin rows) folds into one `other`
// count. The bars and every percentage divide by `total`, which is the sum of
// all of it — dropping the unnamed methods inflated the named shares (3
// transcodes beside 97 unknown sessions read "100% Transcode").
// Zero-import, so it can be unit-tested.

export const STREAM_METHODS = ["DirectPlay", "DirectStream", "Transcode"] as const;
export type StreamMethod = (typeof STREAM_METHODS)[number];

export interface StreamMix {
  counts: Record<StreamMethod, number>;
  other: number;
  total: number;
}

function isStreamMethod(method: string): method is StreamMethod {
  return (STREAM_METHODS as readonly string[]).includes(method);
}

export function foldStreamMethods(ratio: readonly { method: string; count: number }[]): StreamMix {
  const counts: Record<StreamMethod, number> = { DirectPlay: 0, DirectStream: 0, Transcode: 0 };
  let other = 0;
  let total = 0;
  for (const r of ratio) {
    total += r.count;
    if (isStreamMethod(r.method)) counts[r.method] += r.count;
    else other += r.count;
  }
  return { counts, other, total };
}

/** A stream-type bar segment: a named method, or the one "Other" bucket. */
export type StreamSegmentKey = StreamMethod | "Other";

// The bars' segments in display order: the three named methods always, then
// one "Other" only when the server recorded something else. Their counts sum
// to `total`, so every share divides by the same number the bars do.
export function streamMixSegments(mix: StreamMix): { key: StreamSegmentKey; count: number }[] {
  const out: { key: StreamSegmentKey; count: number }[] = STREAM_METHODS.map((m) => ({
    key: m,
    count: mix.counts[m],
  }));
  if (mix.other > 0) out.push({ key: "Other", count: mix.other });
  return out;
}
