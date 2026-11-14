// Browsing TMDB: the discovery lists, search, a title's detail, TV seasons and
// episode availability, people, and ratings.

import {
  RATING_FIELDS,
  tooLargeAnswer,
  RETRY_AFTER_HEADER,
  TMDB_MEDIA_TYPE,
  TMDB_ID_NAME,
  TMDB_WATCH_PROVIDER,
} from "../shared";
import { RATINGS_BATCH_MAX_ITEMS } from "@/lib/api-body-limits";
import type { OpenApiSchema, OpenApiPaths } from "../types";

const TMDB_MEDIA_LIST = { type: "array", items: { $ref: "#/components/schemas/TmdbMedia" } } satisfies OpenApiSchema;

// A related or collection title on GET /media/{type}/{tmdbId} — the route's
// `lite` projection (poster, label and availability marks only).
const MEDIA_DETAIL_LITE = {
  type: "object",
  properties: {
    tmdbId: { type: "integer" },
    mediaType: TMDB_MEDIA_TYPE,
    title: { type: "string" },
    posterPath: { type: "string", nullable: true },
    releaseYear: { type: "string", nullable: true },
    plexAvailable: { type: "boolean" },
    jellyfinAvailable: { type: "boolean" },
    arrPending: { type: "boolean" },
    requested: { type: "boolean" },
  },
} satisfies OpenApiSchema;

// A most-played title on GET /popular: the title plus its play counts
// (EnrichedMedia, src/app/api/popular/route.ts).
const SERVER_POPULAR_TITLE = {
  allOf: [
    { $ref: "#/components/schemas/TmdbMedia" },
    {
      type: "object",
      properties: {
        plays: { type: "integer", description: "Completed watches in the sort's window (a show sums its episodes)" },
        allTimePlays: { type: "integer" },
        viewers: { type: "integer" },
        episodes: { type: "integer" },
        totalHours: { type: "number" },
      },
    },
  ],
} satisfies OpenApiSchema;

export const discoveryPaths: OpenApiPaths = {
  "/browse": {
    get: {
      tags: ["Discovery"],
      summary: "Discover/browse movies or TV with filters and availability enrichment",
      parameters: [
        { name: "mediaType", in: "query", schema: { type: "string", enum: ["movie", "tv"], default: "movie" }, description: "Anything but `tv` is read as `movie`" },
        { name: "page", in: "query", schema: { type: "integer", default: 1 } },
        { name: "sortBy", in: "query", schema: { type: "string" } },
        { name: "genreId", in: "query", schema: { type: "string" } },
        { name: "keywordId", in: "query", schema: { type: "string" } },
        { name: "companyId", in: "query", schema: { type: "string" }, description: "TMDB production company id(s), digits separated by , or |. Movies and TV." },
        { name: "networkId", in: "query", schema: { type: "string" }, description: "TMDB TV network id(s), digits separated by , or |. Ignored for movies." },
        { name: "certification", in: "query", schema: { type: "string", enum: ["G", "PG", "PG-13", "R", "NC-17"] }, description: "Highest US certification to include. Movies only (ignored for TV); titles with no US rating are excluded." },
        { name: "fromYear", in: "query", schema: { type: "integer" } },
        { name: "toYear", in: "query", schema: { type: "integer" } },
        { name: "minRating", in: "query", schema: { type: "number" } },
        { name: "minVoteCount", in: "query", schema: { type: "integer" } },
        { name: "ratingFilter", in: "query", schema: { type: "string" } },
        { name: "watchProvider", in: "query", schema: { type: "string" } },
        { name: "watchRegion", in: "query", schema: { type: "string" } },
        { name: "hideAvailable", in: "query", schema: { type: "string", enum: ["1"] }, description: "`1` hides titles available on a server the user can see; any other value is off" },
      ],
      responses: {
        "200": {
          description: "{ items, totalPages, page } — discovery results with availability enrichment",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["items", "totalPages", "page"],
                properties: {
                  items: TMDB_MEDIA_LIST,
                  totalPages: { type: "integer" },
                  page: { type: "integer" },
                },
              },
            },
          },
        },
        "429": { description: "Rate limited (30 req/min per user)" },
        "500": { description: "{ error } — the TMDB query failed" },
      },
    },
  },
  "/home": {
    get: {
      tags: ["Discovery"],
      summary: "Home discovery rails (trending / popular / etc.)",
      parameters: [
        { name: "hideAvailable", in: "query", schema: { type: "string", enum: ["1"] }, description: "`1` hides titles available on a server the user can see" },
      ],
      responses: {
        "200": {
          description: "{ featured, carousels, failedSources } — grouped discovery rails with availability enrichment",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["featured", "carousels", "failedSources"],
                properties: {
                  featured: { ...TMDB_MEDIA_LIST, description: "The first trending movie and the first trending TV title (0–2 items)" },
                  carousels: {
                    type: "array",
                    description:
                      "The rails that have at least one title, in display order. `id` is trending, recently-added, for-you, popular-movies, popular-tv, " +
                      "upcoming-movies, on-the-air-tv, top-rated-movies or top-rated-tv — an additive set, so render an unknown id generically. " +
                      "`title` is in the viewer's language.",
                    items: {
                      type: "object",
                      required: ["id", "title", "items"],
                      properties: { id: { type: "string" }, title: { type: "string" }, items: TMDB_MEDIA_LIST },
                    },
                  },
                  failedSources: {
                    type: "array",
                    items: {
                      type: "string",
                      enum: ["trending", "popular-movies", "popular-tv", "upcoming-movies", "on-the-air-tv", "top-rated-movies", "top-rated-tv"],
                    },
                    description:
                      "Additive: the TMDB rails (by carousel id) that could not be loaded and so came back with no titles — an empty feed with " +
                      "failed sources is an outage, not an empty catalog. Always sent, empty when every rail answered; a server older than this field omits it.",
                  },
                },
              },
            },
          },
        },
        "429": { description: "Rate limited (30 req/min per user)" },
        "500": { description: "{ error }" },
      },
    },
  },
  "/recommendations": {
    get: {
      tags: ["Discovery"],
      summary: "Full personalized For You set with availability enrichment",
      parameters: [
        { name: "filter", in: "query", schema: { type: "string", enum: ["available", "missing"] }, description: "Restrict to titles on (or not on) the user's media servers" },
        { name: "type", in: "query", schema: { type: "string", enum: ["movie", "tv"] }, description: "Restrict to one media type" },
        { name: "sort", in: "query", schema: { type: "string", enum: ["match", "newest", "rating"], default: "match" }, description: "Ordering; \"match\" keeps the engine's own ranking" },
      ],
      responses: {
        "200": {
          description: "Ranked recommendation items ({ items, total, available }); each item carries recommendedBecause naming the strongest seed, plus recommendedBecause.seeds listing every seed (strongest first, capped at 25; seedCount is the true total)",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["items", "total", "available"],
                properties: {
                  items: TMDB_MEDIA_LIST,
                  total: { type: "integer", description: "How many titles passed the filter (the length of `items`)" },
                  available: { type: "integer", description: "The whole ranked set before the filter" },
                },
              },
            },
          },
        },
        "404": { description: "feature.page.forYou is disabled" },
        "429": { description: "Rate limited (30 req/min per user)" },
        "500": { description: "{ error }" },
      },
    },
  },
  "/popular": {
    get: {
      tags: ["Discovery"],
      summary: "Most-played movies and TV on the connected media servers",
      parameters: [
        { name: "mediaType", in: "query", schema: { type: "string", enum: ["movies", "movie", "tv"] }, description: "Restrict to one type (\"movie\" is accepted for \"movies\"); omitted returns both; any other value is 400" },
        { name: "page", in: "query", schema: { type: "integer", default: 1 }, description: "Clamped to 100. A page past the ranking's own last page is served as asked, with empty lists" },
        { name: "sort", in: "query", schema: { type: "string", enum: ["trending", "plays", "viewers"], default: "trending" } },
      ],
      responses: {
        "200": {
          description: "{ movies, tv, totalMovies, totalTv, totalPages, page, sort, rankOffset } with availability enrichment",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["movies", "tv", "totalMovies", "totalTv", "totalPages", "page", "sort", "rankOffset"],
                properties: {
                  movies: { type: "array", items: SERVER_POPULAR_TITLE },
                  tv: { type: "array", items: SERVER_POPULAR_TITLE },
                  totalMovies: { type: "integer" },
                  totalTv: { type: "integer" },
                  totalPages: { type: "integer" },
                  page: { type: "integer", description: "The page served: the requested page, at most 100. Past the ranking's own last page (`totalPages`) the lists are empty" },
                  sort: { type: "string", enum: ["plays", "viewers", "trending"] },
                  rankOffset: { type: "integer", description: "The rank before this page's first title: (served page − 1) × the page size" },
                },
              },
            },
          },
        },
        "400": { description: "{ error } — mediaType is not movies, movie or tv" },
        "403": { description: "feature.page.popular is disabled" },
        "429": { description: "Rate limited (30 req/min per user)" },
        "500": { description: "{ error } — reading the play counts or the titles failed" },
      },
    },
  },
  "/upcoming": {
    get: {
      tags: ["Discovery"],
      summary: "Upcoming releases",
      parameters: [
        { name: "hideAvailable", in: "query", schema: { type: "string", enum: ["1"] }, description: "`1` hides titles available on a server the user can see" },
      ],
      responses: {
        "200": {
          description: "{ items } — upcoming releases (movies and TV interleaved by date) with availability enrichment",
          content: { "application/json": { schema: { type: "object", required: ["items"], properties: { items: TMDB_MEDIA_LIST } } } },
        },
        "403": { description: "feature.page.upcoming is disabled" },
        "429": { description: "Rate limited (30 req/min per user)" },
        "500": { description: "{ error }" },
        "502": { description: "{ error } — nothing to show because a read failed (a failed live fallback beside cached titles still answers 200 with what was cached)" },
      },
    },
  },
  "/top-rated": {
    get: {
      tags: ["Discovery"],
      summary: "Top-rated movies or TV",
      parameters: [
        { name: "mediaType", in: "query", schema: { type: "string", enum: ["movies", "tv"] }, description: "Restrict to one type (note the plural \"movies\"); omitted returns both" },
        { name: "page", in: "query", schema: { type: "integer", default: 1 } },
        { name: "sortBy", in: "query", schema: { type: "string", enum: ["imdb", "letterboxd", "rt", "trakt", "mdblist"], default: "imdb" }, description: "Rating source to sort by; an unknown value is read as `imdb`" },
        { name: "fromYear", in: "query", schema: { type: "string", pattern: "^\\d{4}$" }, description: "4-digit year; anything else is ignored" },
        { name: "toYear", in: "query", schema: { type: "string", pattern: "^\\d{4}$" }, description: "4-digit year; anything else is ignored" },
        { name: "minImdb", in: "query", schema: { type: "number" } },
        { name: "minVotes", in: "query", schema: { type: "integer" } },
        { name: "hideAvailable", in: "query", schema: { type: "string", enum: ["1"] }, description: "`1` hides titles available on a server the user can see" },
      ],
      responses: {
        "200": {
          description: "{ movies, tv, totalMovies, totalTv, totalPages, page, sortBy, failedSources } with availability enrichment",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["movies", "tv", "totalMovies", "totalTv", "totalPages", "page", "sortBy", "failedSources"],
                properties: {
                  movies: TMDB_MEDIA_LIST,
                  tv: TMDB_MEDIA_LIST,
                  totalMovies: { type: "integer" },
                  totalTv: { type: "integer" },
                  totalPages: { type: "integer" },
                  page: { type: "integer" },
                  sortBy: { type: "string", enum: ["imdb", "letterboxd", "rt", "trakt", "mdblist"], description: "The sort actually applied" },
                  failedSources: {
                    type: "array",
                    items: { type: "string", enum: ["tmdb", "trakt", "mdblist"] },
                    description: "Additive: the rating sources that failed or answered incompletely, so the lists are missing their titles (an empty list with a failed source is an outage, not an empty ranking). Empty when every source answered.",
                  },
                },
              },
            },
          },
        },
        "403": { description: "feature.page.top is disabled" },
        "429": { description: "Rate limited (30 req/min per user)" },
        "500": { description: "{ error }" },
      },
    },
  },
  "/media/{type}/{tmdbId}": {
    get: {
      tags: ["Discovery"],
      summary: "Native detail payload (title detail + related rail + availability)",
      parameters: [
        { name: "type", in: "path", required: true, schema: { type: "string", enum: ["movie", "tv"] } },
        { name: "tmdbId", in: "path", required: true, schema: { type: "integer" } },
      ],
      responses: {
        "200": {
          description: "Title detail with availability + suggestions",
          content: {
            "application/json": {
              schema: {
                allOf: [
                  { $ref: "#/components/schemas/TmdbMedia" },
                  {
                    type: "object",
                    required: ["cast", "similar", "keywords", "keywordList", "genreList", "watchProviders", "homepage", "collection", "votedByMe", "onWatchlist", "onHidden"],
                    properties: {
                      cast: {
                        type: "array",
                        description: "Top cast; empty when the credits fetch failed",
                        items: {
                          type: "object",
                          properties: { id: { type: "integer" }, name: { type: "string" }, character: { type: "string" }, profilePath: { type: "string", nullable: true } },
                        },
                      },
                      similar: { type: "array", items: MEDIA_DETAIL_LITE, description: "Up to 12 related titles" },
                      keywords: { type: "array", items: { type: "string" } },
                      keywordList: { type: "array", items: TMDB_ID_NAME },
                      genreList: { type: "array", items: TMDB_ID_NAME },
                      watchProviders: { type: "array", items: TMDB_WATCH_PROVIDER, description: "US region" },
                      homepage: { type: "string", nullable: true },
                      collection: {
                        type: "object",
                        nullable: true,
                        description: "Movies only: the collection's parts; null when the title has none or the fetch failed",
                        properties: { id: { type: "integer" }, name: { type: "string" }, items: { type: "array", items: MEDIA_DETAIL_LITE } },
                      },
                      votedByMe: { type: "boolean", description: "The caller has an open deletion vote on the title" },
                      onWatchlist: { type: "boolean" },
                      onHidden: { type: "boolean" },
                      requested4kByMe: { type: "boolean", description: "Present only when the viewer can see 4K state: the caller holds an open 4K request" },
                    },
                  },
                ],
              },
            },
          },
        },
        "400": { description: "Invalid type or tmdbId" },
        "404": { description: "{ error } — TMDB has no such title" },
        "502": { description: "Could not load this title" },
        "429": { description: "Rate limited" },
      },
    },
  },
  "/search": {
    get: {
      tags: ["Search"],
      summary: "Search TMDB for movies or TV shows",
      parameters: [
        { name: "q", in: "query", schema: { type: "string", maxLength: 200 }, description: "An empty or whitespace-only query answers 200 with `[]`" },
        { name: "type", in: "query", schema: { type: "string", enum: ["movie", "tv"] } },
      ],
      responses: {
        "200": {
          description:
            "Search results (TmdbMedia) enriched with library availability and request/ARR state. Ratings are not attached: " +
            "a search runs on every keystroke, so it skips the MDBList/OMDB fan-out.",
          content: { "application/json": { schema: TMDB_MEDIA_LIST } },
        },
        "400": { description: "Query longer than 200 characters", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        "429": { description: "Rate limited (30 req/min per user)" },
        "500": { description: "{ error } — TMDB search failed" },
        "503": { description: "Maintenance mode (non-ADMIN callers)" },
      },
    },
  },
  "/tv/{id}/season/{n}": {
    get: {
      tags: ["TV"],
      summary: "Get episode data for a season",
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "integer" }, description: "TMDB TV ID" },
        { name: "n", in: "path", required: true, schema: { type: "integer" }, description: "Season number" },
      ],
      responses: {
        "200": {
          description: "Season episodes with availability",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["episodes", "owned", "source"],
                properties: {
                  episodes: {
                    type: "array",
                    description: "TMDB's episodes, in the viewer's language",
                    items: {
                      type: "object",
                      properties: {
                        episodeNumber: { type: "integer" },
                        seasonNumber: { type: "integer" },
                        name: { type: "string" },
                        overview: { type: "string" },
                        airDate: { type: "string", nullable: true },
                        stillPath: { type: "string", nullable: true },
                        runtime: { type: "integer", nullable: true, description: "Minutes" },
                        voteAverage: { type: "number" },
                      },
                    },
                  },
                  owned: { type: "array", items: { type: "integer" }, description: "Episode numbers on a server this viewer may see, ascending" },
                  source: { type: "string", nullable: true, enum: ["plex", "jellyfin", "both", null], description: "Which server type holds the owned episodes; null when none" },
                },
              },
            },
          },
        },
        "400": { description: "Invalid TV id or season number" },
        "404": { description: "TMDB has no such show or season" },
        "429": { description: "Rate limited" },
        "502": { description: "TMDB season fetch failed" },
      },
    },
  },
  "/tv-availability": {
    get: {
      tags: ["TV Availability"],
      summary: "Episode-level availability for a TV show",
      parameters: [
        { name: "tmdbId", in: "query", required: true, schema: { type: "integer", minimum: 1 } },
      ],
      description: "Scoped by the caller's sign-in provider (a Plex user sees Plex episodes, a Jellyfin user Jellyfin, others both) and by the servers they may see. There is no `source` parameter.",
      responses: {
        "200": {
          description: "{ source: \"plex\" | \"jellyfin\" | \"both\" | null, seasons: [{ seasonNumber, episodes: number[] }] }",
          content: { "application/json": { schema: { type: "object", properties: {
            source: { type: "string", nullable: true, enum: ["plex", "jellyfin", "both", null] },
            seasons: { type: "array", items: { type: "object", properties: { seasonNumber: { type: "integer" }, episodes: { type: "array", items: { type: "integer" } } } } },
          } } } },
        },
        "400": { description: "Missing, non-positive or out-of-range tmdbId" },
        "429": { description: "Rate limited (30 req/min per user)" },
      },
    },
  },
  "/person/{id}": {
    get: {
      tags: ["Person"],
      summary: "Get TMDB person details and credits",
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
      responses: {
        "200": {
          description: "Person details with cast/crew credits (titles the caller marked \"not interested\" are left out)",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["id", "name", "profilePath", "knownForDepartment", "biography", "birthday", "deathday", "placeOfBirth", "credits"],
                properties: {
                  id: { type: "integer" },
                  name: { type: "string" },
                  profilePath: { type: "string", nullable: true },
                  knownForDepartment: { type: "string" },
                  biography: { type: "string", description: "In the viewer's language when TMDB has one" },
                  birthday: { type: "string", nullable: true },
                  deathday: { type: "string", nullable: true },
                  placeOfBirth: { type: "string", nullable: true },
                  credits: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        id: { type: "integer" },
                        mediaType: TMDB_MEDIA_TYPE,
                        title: { type: "string" },
                        posterPath: { type: "string", nullable: true },
                        releaseYear: { type: "string" },
                        character: { type: "string" },
                        voteAverage: { type: "number" },
                        plexAvailable: { type: "boolean" },
                        jellyfinAvailable: { type: "boolean" },
                        arrPending: { type: "boolean" },
                        requested: { type: "boolean" },
                        requestedByMe: { type: "boolean" },
                        blacklisted: { type: "boolean" },
                        ...RATING_FIELDS,
                        requestToken: {
                          type: "string",
                          description: "This caller's `_token` for POST /requests on this title — the HMAC GET /requests/token answers, bound to the title and the caller",
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        "400": { description: "Invalid person id" },
        "404": { description: "Unknown person" },
        "429": { description: "Rate limited" },
        "502": { description: "TMDB upstream error" },
      },
    },
  },
  "/ratings": {
    get: {
      tags: ["Ratings"],
      summary: "Get external ratings for a title (MDBList → OMDB fallback)",
      parameters: [
        { name: "id", in: "query", required: true, schema: { type: "integer" }, description: "TMDB ID" },
        { name: "type", in: "query", required: true, schema: { type: "string", enum: ["movie", "tv"] } },
      ],
      responses: {
        "200": {
          description: "Ratings object, or null when no ratings are found for the title",
          content: {
            "application/json": {
              schema: {
                type: "object",
                nullable: true,
                description:
                  "String-valued rating fields from MDBList (or OMDB fallback). Any field may be null.",
                properties: {
                  ...RATING_FIELDS,
                  releasedDigital: { type: "string", nullable: true, description: "MDBList's digital release date (MDBList only)" },
                  trailerUrl: { type: "string", nullable: true, description: "MDBList's trailer link (MDBList only)" },
                },
              },
            },
          },
        },
        "400": { description: "Missing or invalid id / type, or a non-positive / out-of-range id" },
        "429": { description: "Rate limited (60 req/min)", headers: RETRY_AFTER_HEADER },
      },
    },
  },
  "/ratings/batch": {
    post: {
      tags: ["Ratings"],
      summary: "Batch fetch ratings for multiple titles",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["items"],
              properties: {
                items: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      id: { type: "integer" },
                      type: { type: "string", enum: ["movie", "tv"] },
                      releaseDate: { type: "string", nullable: true, description: "Optional; picks the ratings-cache TTL bucket" },
                    },
                  },
                  maxItems: RATINGS_BATCH_MAX_ITEMS,
                  description: `At most ${RATINGS_BATCH_MAX_ITEMS} items; malformed or out-of-range entries and duplicates are skipped silently`,
                },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "{ ratings } — a map keyed \"<type>:<tmdbId>\" (e.g. \"movie:603\") → { imdbId, imdbRating, imdbVotes, rottenTomatoes, rtAudienceScore, metacritic, traktRating, letterboxdRating, mdblistScore, malRating, rogerEbertRating } (strings or null); titles with no ratings are omitted",
          content: { "application/json": { schema: { type: "object", properties: {
            ratings: { type: "object", additionalProperties: { type: "object", properties: RATING_FIELDS } },
          } } } },
        },
        "400": { description: `\`items\` missing / not an array, or over ${RATINGS_BATCH_MAX_ITEMS} entries` },
        "413": tooLargeAnswer(1024 * 1024),
        "429": { description: "Rate limited (10 req/min per user)" },
      },
    },
  },
};
