// The document's security schemes and named component schemas.

import { RATING_FIELDS, TMDB_MEDIA_TYPE, TMDB_ID_NAME, TMDB_WATCH_PROVIDER } from "./shared";
import type { OpenApiSchema, OpenApiDocument } from "./types";

const RECOMMENDATION_SEED_SOURCE = { type: "string", enum: ["WATCH_HISTORY", "WATCHLIST", "REQUEST"] } satisfies OpenApiSchema;

// One title as every discovery read answers it: TmdbMedia (src/lib/tmdb-types.ts)
// after the attachAllAvailability chokepoint (src/lib/attach-all.ts). A list row
// carries what TMDB's list gave; the detail fields fill in on the single-title
// read. `arrInstances` is left out — that chokepoint never copies it. Served as
// components.schemas.TmdbMedia, so a generated client gets one named type.
const TMDB_MEDIA = {
  type: "object",
  required: ["id", "mediaType", "title", "overview", "posterPath", "backdropPath", "releaseDate", "releaseYear", "voteAverage"],
  properties: {
    id: { type: "integer", description: "TMDB id" },
    mediaType: TMDB_MEDIA_TYPE,
    title: { type: "string", description: "In the viewer's language when TMDB has a translation" },
    overview: { type: "string" },
    posterPath: { type: "string", nullable: true, description: "TMDB image path (prefix https://image.tmdb.org/t/p/<size>)" },
    backdropPath: { type: "string", nullable: true },
    releaseDate: { type: "string", nullable: true, description: "YYYY-MM-DD (first air date for TV)" },
    releaseYear: { type: "string", nullable: true },
    voteAverage: { type: "number" },
    voteCount: { type: "integer" },
    certification: { type: "string", description: "US content rating" },
    plexAvailable: { type: "boolean", description: "On a Plex server this viewer may see" },
    jellyfinAvailable: { type: "boolean", description: "On a Jellyfin server this viewer may see" },
    arrPending: { type: "boolean", description: "Wanted by the default Radarr/Sonarr, not yet on disk" },
    arr4kPending: { type: "boolean", description: "Only when the viewer can see 4K state" },
    arr4kAvailable: { type: "boolean", description: "Only when the viewer can see 4K state" },
    requested: { type: "boolean" },
    requestedByMe: { type: "boolean" },
    blacklisted: { type: "boolean", description: "Present (true) only when an admin blacklisted the title: it is shown, but a request is refused" },
    ...RATING_FIELDS,
    releasedDigital: { type: "string", nullable: true },
    digitalReleaseDate: { type: "string", nullable: true, description: "Movies only; absent when not fetched yet, null when TMDB has none" },
    physicalReleaseDate: { type: "string", nullable: true, description: "Movies only; absent when not fetched yet, null when TMDB has none" },
    trailerUrl: { type: "string", nullable: true },
    trailerKey: { type: "string", nullable: true },
    collectionId: { type: "integer", nullable: true },
    collectionName: { type: "string", nullable: true },
    seasons: {
      type: "array",
      items: {
        type: "object",
        properties: {
          seasonNumber: { type: "integer" },
          episodeCount: { type: "integer" },
          airDate: { type: "string", nullable: true },
          posterPath: { type: "string", nullable: true },
          name: { type: "string" },
          overview: { type: "string" },
        },
      },
    },
    genres: { type: "array", items: { type: "string" } },
    genreList: { type: "array", items: TMDB_ID_NAME, description: "`genres` with their TMDB ids, for browse deep links" },
    studios: { type: "array", items: { type: "string" } },
    studioList: {
      type: "array",
      items: { type: "object", properties: { id: { type: "integer" }, name: { type: "string" }, kind: { type: "string", enum: ["company", "network"] } } },
    },
    tagline: { type: "string", nullable: true },
    status: { type: "string", nullable: true },
    runtime: { type: "integer", nullable: true, description: "Minutes" },
    numberOfSeasons: { type: "integer", nullable: true },
    numberOfEpisodes: { type: "integer", nullable: true },
    originalTitle: { type: "string", nullable: true },
    originalLanguage: { type: "string", nullable: true },
    spokenLanguages: { type: "array", items: { type: "string" } },
    productionCountries: { type: "array", items: { type: "string" }, description: "Display names" },
    originCountryCodes: { type: "array", items: { type: "string" }, description: "ISO 3166-1 codes" },
    productionCountryCodes: { type: "array", items: { type: "string" }, description: "ISO codes, index-aligned with productionCountries" },
    homepage: { type: "string", nullable: true },
    budget: { type: "integer", nullable: true },
    revenue: { type: "integer", nullable: true },
    keywords: { type: "array", items: { type: "string" } },
    keywordList: { type: "array", items: TMDB_ID_NAME, description: "`keywords` with their TMDB ids, for browse deep links" },
    watchProviders: { type: "array", items: TMDB_WATCH_PROVIDER, description: "US region" },
    tvdbId: { type: "integer", nullable: true },
    lastAirDate: { type: "string", nullable: true },
    inProduction: { type: "boolean", nullable: true },
    tvType: { type: "string", nullable: true },
    nextEpisodeAirDate: { type: "string", nullable: true },
    recommendedBecause: {
      type: "object",
      description: "For You reads only: the strongest seed that surfaced the title",
      properties: {
        tmdbId: { type: "integer" },
        title: { type: "string" },
        mediaType: TMDB_MEDIA_TYPE,
        source: { type: "string", enum: ["WATCH_HISTORY", "WATCHLIST", "REQUEST", "TRENDING"], description: "TRENDING never appears: a fallback row carries fromTrendingFallback instead" },
        seedCount: { type: "integer", description: "How many seeds agreed (the true total)" },
        seeds: {
          type: "array",
          description: "Every seed, strongest first, capped (seedCount is the true total); absent on rows stored before the list was",
          items: { type: "object", properties: { tmdbId: { type: "integer" }, title: { type: "string" }, mediaType: TMDB_MEDIA_TYPE, source: RECOMMENDATION_SEED_SOURCE } },
        },
      },
    },
    fromTrendingFallback: { type: "boolean", description: "For You reads only: a cold-start row that is popular, not matched to the viewer" },
    matchTier: { type: "string", enum: ["top", "strong"], description: "For You reads only: absent outside a labelled band" },
  },
} satisfies OpenApiSchema;

export const components = {
  securitySchemes: {
    session: {
      type: "apiKey",
      in: "cookie",
      name: "__Host-summonarr-session",
      description:
        "Summonarr session JWT (jose HS256), web transport. Named `summonarr-session` in non-HTTPS contexts.",
    },
    sessionBearer: {
      type: "http",
      scheme: "bearer",
      bearerFormat: "JWT",
      description:
        "Same session JWT delivered to native/mobile clients via the sign-in response body (`Authorization: Bearer <session-jwt>`). Every authenticated route resolves bearer first, then the session cookie, so this is accepted anywhere the `session` cookie scheme is.",
    },
    cronSecret: {
      type: "http",
      scheme: "bearer",
      description: "CRON_SECRET bearer token for sync/cron routes",
    },
  },
  schemas: {
    MediaType: { type: "string", enum: ["MOVIE", "TV"] },
    TmdbMedia: TMDB_MEDIA,
    RequestStatus: {
      type: "string",
      enum: ["PENDING", "APPROVED", "DECLINED", "AVAILABLE"],
    },
    UserRole: { type: "string", enum: ["USER", "ADMIN", "ISSUE_ADMIN"] },
    OidcAllowlist: {
      type: "object",
      properties: {
        groups: { type: "array", items: { type: "string", maxLength: 256 }, maxItems: 50 },
        groupsClaim: { type: "string", pattern: "^[A-Za-z0-9_.:/-]{1,128}$", default: "groups" },
        requestGroupsScope: { type: "boolean", default: false },
        emailDomains: { type: "array", items: { type: "string" }, maxItems: 50 },
        existingUsersOnly: { type: "boolean", default: false },
      },
    },
    QueueImportFile: {
      type: "object",
      description: "One file of a queued download, chosen by the path Radarr/Sonarr reported, with optional corrections (ids only — the objects are read from the instance)",
      required: ["path"],
      properties: {
        path: { type: "string", maxLength: 4096 },
        movieId: { type: "integer", minimum: 1, description: "Radarr: re-match to this movie" },
        seriesId: { type: "integer", minimum: 1, description: "Sonarr: re-match to this series (requires episodeIds)" },
        episodeIds: { type: "array", items: { type: "integer", minimum: 1 }, minItems: 1, maxItems: 500, description: "Sonarr: the episodes the file holds" },
        qualityId: { type: "integer", minimum: 0 },
        languageIds: { type: "array", items: { type: "integer", minimum: -2 }, maxItems: 50 },
        releaseGroup: { type: "string", maxLength: 100 },
        releaseType: { type: "string", enum: ["unknown", "singleEpisode", "multiEpisode", "seasonPack"], description: "Sonarr only" },
      },
    },
    WatchGradeSpread: {
      type: "object",
      nullable: true,
      description: "Users per letter; notGraded = approved, fulfilled requests but no letter yet",
      properties: {
        A: { type: "integer" },
        B: { type: "integer" },
        C: { type: "integer" },
        D: { type: "integer" },
        F: { type: "integer" },
        notGraded: { type: "integer" },
      },
    },
    CleanupSettings: {
      type: "object",
      description: "Library cleanup rules. Day-based exclusions take 0 to mean off.",
      properties: {
        unwatchedEnabled: { type: "boolean" },
        unwatchedDays: { type: "integer", minimum: 1, maximum: 3650 },
        neverWatchedEnabled: { type: "boolean" },
        neverWatchedDays: { type: "integer", minimum: 1, maximum: 3650 },
        votesEnabled: { type: "boolean" },
        votesMin: { type: "integer", minimum: 1, maximum: 1000 },
        minAgeDays: { type: "integer", minimum: 0, maximum: 3650 },
        recentRequestDays: { type: "integer", minimum: 0, maximum: 3650 },
        excludeAiring: { type: "boolean" },
        requireUpstreamCheck: { type: "boolean", description: "Hold back watch-rule candidates until every holding server's own watch records were checked successfully within 7 days (exclusion `upstreamUnchecked`). Default true." },
      },
    },
    IssueType: {
      type: "string",
      enum: ["BAD_VIDEO", "WRONG_AUDIO", "MISSING_SUBTITLES", "WRONG_MATCH", "OTHER"],
    },
    IssueStatus: {
      type: "string",
      enum: ["OPEN", "IN_PROGRESS", "RESOLVED"],
    },
    IssueScope: {
      type: "string",
      enum: ["FULL", "SEASON", "EPISODE"],
    },
    MediaRequest: {
      type: "object",
      properties: {
        id: { type: "string" },
        tmdbId: { type: "integer" },
        mediaType: { $ref: "#/components/schemas/MediaType" },
        title: { type: "string" },
        posterPath: { type: "string", nullable: true },
        releaseYear: { type: "string", nullable: true },
        status: { $ref: "#/components/schemas/RequestStatus" },
        note: { type: "string", nullable: true },
        adminNote: { type: "string", nullable: true },
        approvedAt: {
          type: "string",
          format: "date-time",
          nullable: true,
          description:
            "When this request was approved by a decision: an admin, or auto-approve at creation. Cleared on " +
            "decline. null if it never was itself — a copy of an already-approved request, or a PENDING request a " +
            "library sync marked AVAILABLE when its title arrived. Present on responses that return the whole row.",
        },
        createdAt: { type: "string", format: "date-time" },
        updatedAt: { type: "string", format: "date-time" },
      },
    },
    Issue: {
      type: "object",
      properties: {
        id: { type: "string" },
        tmdbId: { type: "integer" },
        tvdbId: { type: "integer", nullable: true },
        mediaType: { $ref: "#/components/schemas/MediaType" },
        title: { type: "string" },
        posterPath: { type: "string", nullable: true },
        issueType: { $ref: "#/components/schemas/IssueType" },
        scope: { $ref: "#/components/schemas/IssueScope" },
        seasonNumber: { type: "integer", nullable: true },
        episodeNumber: { type: "integer", nullable: true },
        note: { type: "string", nullable: true },
        status: { $ref: "#/components/schemas/IssueStatus" },
        resolution: { type: "string", nullable: true },
        createdAt: { type: "string", format: "date-time" },
        updatedAt: { type: "string", format: "date-time", description: "Present on the whole-row answers (POST /issues, PATCH /issues/{id})" },
        reportedBy: { type: "string", description: "The reporter's user id (whole-row answers)" },
        claimedBy: { type: "string", nullable: true, description: "The admin who claimed the issue (whole-row answers)" },
        claimedAt: { type: "string", format: "date-time", nullable: true, description: "Whole-row answers" },
        resolvedAt: { type: "string", format: "date-time", nullable: true, description: "When the issue last moved to RESOLVED (whole-row answers)" },
        playbackContext: { type: "object", nullable: true, additionalProperties: true, description: "The reporter's last play of the title, snapshotted at filing; never an IP address. Opaque, version-tagged JSON (whole-row answers)" },
      },
    },
    Error: {
      type: "object",
      properties: { error: { type: "string" } },
      required: ["error"],
    },
    PaginatedMeta: {
      type: "object",
      properties: {
        total: { type: "integer" },
        page: { type: "integer" },
        pageSize: { type: "integer" },
      },
    },
  },
} satisfies OpenApiDocument["components"];
