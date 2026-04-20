import { NextRequest, NextResponse } from "next/server";
import { auth, isTokenExpired } from "@/lib/auth";
import { attachRatingsUnified } from "@/lib/omdb-availability";
import type { TmdbMedia, MediaType } from "@/lib/tmdb-types";
import { checkRateLimit } from "@/lib/rate-limit";

const MAX_BATCH = 200;

type ReqItem = { id: number; type: MediaType; releaseDate: string | null };

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session || isTokenExpired(session)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!checkRateLimit(`ratings-batch:${session.user.id}`, 10, 60_000)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const rawItems = (body as { items?: unknown })?.items;
  if (!Array.isArray(rawItems)) {
    return NextResponse.json({ error: "Missing items array" }, { status: 400 });
  }
  if (rawItems.length === 0) return NextResponse.json({ ratings: {} });
  if (rawItems.length > MAX_BATCH) {
    return NextResponse.json({ error: `Too many items (max ${MAX_BATCH})` }, { status: 400 });
  }

  const seen = new Set<string>();
  const items: ReqItem[] = [];
  for (const raw of rawItems) {
    if (!raw || typeof raw !== "object") continue;
    const { id, type, releaseDate } = raw as { id?: unknown; type?: unknown; releaseDate?: unknown };
    if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) continue;
    if (type !== "movie" && type !== "tv") continue;
    const key = `${type}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ id, type, releaseDate: typeof releaseDate === "string" ? releaseDate : null });
  }

  const stubs: TmdbMedia[] = items.map((i) => ({
    id: i.id,
    mediaType: i.type,
    title: "",
    overview: "",
    posterPath: null,
    backdropPath: null,
    releaseDate: i.releaseDate,
    releaseYear: "",
    voteAverage: 0,
  }));

  const enriched = await attachRatingsUnified(stubs, { blocking: true });

  const ratings: Record<string, unknown> = {};
  for (const item of enriched) {
    if (
      item.imdbId == null &&
      item.imdbRating == null &&
      item.rottenTomatoes == null &&
      item.rtAudienceScore == null &&
      item.metacritic == null &&
      item.traktRating == null &&
      item.letterboxdRating == null &&
      item.mdblistScore == null &&
      item.malRating == null &&
      item.rogerEbertRating == null
    ) continue;
    ratings[`${item.mediaType}:${item.id}`] = {
      imdbId: item.imdbId ?? null,
      imdbRating: item.imdbRating ?? null,
      imdbVotes: item.imdbVotes ?? null,
      rottenTomatoes: item.rottenTomatoes ?? null,
      rtAudienceScore: item.rtAudienceScore ?? null,
      metacritic: item.metacritic ?? null,
      traktRating: item.traktRating ?? null,
      letterboxdRating: item.letterboxdRating ?? null,
      mdblistScore: item.mdblistScore ?? null,
      malRating: item.malRating ?? null,
      rogerEbertRating: item.rogerEbertRating ?? null,
    };
  }

  return NextResponse.json({ ratings });
}
