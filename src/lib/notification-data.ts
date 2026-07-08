// Pure, dependency-free shaper for in-app notification rows. Lives apart from
// in-app-notify.ts (which pulls in `server-only` + the Prisma client) so it can be
// unit-tested and reused by every inbox writer without a single source of the
// field-mapping rules drifting: mediaType string→enum normalization, the
// VarChar(500)/VarChar(1000) title/body caps, and the null defaults.

export interface InAppNotificationInput {
  type: string;
  title: string;
  body: string;
  tmdbId?: number | null;
  mediaType?: string | null;
  posterPath?: string | null;
}

export function buildNotificationData(userId: string, n: InAppNotificationInput) {
  // Annotated (not inferred) so the literals don't widen to `string` when this
  // object is returned without a contextual type — Prisma's mediaType column is a
  // MediaType enum, and `string | null` is not assignable to it.
  const mediaType: "MOVIE" | "TV" | null =
    n.mediaType === "MOVIE" ? "MOVIE" : n.mediaType === "TV" ? "TV" : null;
  return {
    userId,
    type: n.type,
    title: n.title.slice(0, 500),
    body: n.body.slice(0, 1000),
    tmdbId: n.tmdbId ?? null,
    mediaType,
    posterPath: n.posterPath ?? null,
  };
}
