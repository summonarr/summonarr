// Adding a requested title to Radarr/Sonarr — the approval's push and the
// sync's re-push. ONE flow for both services (addToArr): look the title up,
// settle the root folder and quality profile, tag the requester, POST, retry a
// folder collision, and re-monitor an existing unmonitored entry on "already
// added". Each service contributes only what differs (AddPlan). Re-exported by
// arr.ts.
import { prisma } from "./prisma";
import { arrRequesterTagLabel } from "./arr-tags";
import { arrFetch, arrErrorMessage, ArrResponseError, asRecord, singleFlight, type ArrRecord } from "./arr-client";
import { getCfg, instanceLabel, type ArrCfgFull, type ArrVariant } from "./arr-config";
import { pickSeriesByTmdbId, resolveSonarrSeries } from "./arr-id-map";
import { findRadarrMovie, findSonarrSeries } from "./arr-lookup";
import { posInt } from "./arr-parse";
import { sanitizeForLog } from "./sanitize";
import { check, v } from "./validate";

/**
 * Whether an add reached the point of sending POST /movie or /series (set on the
 * line before it). A failure BEFORE it — no config, a lookup, a dark arr refusing
 * the first connection — added nothing; only after it can a timeout or a lost
 * answer (arrWriteOutcomeUnknown) mean the title may have been added anyway.
 */
export interface AddProgress {
  sent: boolean;
}

// ── requester tag ────────────────────────────────────────────────────────────
// Requester tagging (Overseerr parity) — BEST-EFFORT. A grabbed request is tagged
// in Radarr/Sonarr with the requesting user's label so an admin can filter media
// by requester in the *arr UI. Tags are additive metadata with no effect on
// quality/download, so any tagging failure is logged and the add proceeds
// UNTAGGED — it must NEVER fail the add.

// Concurrent adds for one requester (a batch approve runs several at once) share
// ONE find-or-create per instance and label. Each used to read the tag list,
// miss the new label, and POST it: the arr then held duplicate tags or refused
// the later POSTs, and those titles were added untagged.
const tagEnsureInFlight = new Map<string, Promise<number | null>>();

// Find-or-create a tag by label; returns its id, or null on ANY failure so the
// caller proceeds untagged rather than failing the add.
function ensureArrTag(cfg: ArrCfgFull, label: string): Promise<number | null> {
  return singleFlight(tagEnsureInFlight, `${cfg.url}\u0000${label.toLowerCase()}`, () => findOrCreateArrTag(cfg, label));
}

// The id of the tag whose label is `wanted` (lowercase) in a tag list answer.
function tagIdIn(tags: unknown, wanted: string): number | null {
  if (!Array.isArray(tags)) return null;
  for (const x of tags) {
    const t = asRecord(x);
    if (typeof t?.label === "string" && t.label.toLowerCase() === wanted && typeof t.id === "number") return t.id;
  }
  return null;
}

async function findOrCreateArrTag(cfg: ArrCfgFull, label: string): Promise<number | null> {
  const wanted = label.toLowerCase();
  try {
    const existing = tagIdIn(await arrFetch<unknown>(cfg, "/api/v3/tag"), wanted);
    if (existing !== null) return existing;
    try {
      const created = asRecord(await arrFetch<unknown>(cfg, "/api/v3/tag", {
        method: "POST",
        body: JSON.stringify({ label }),
      }));
      return typeof created?.id === "number" ? created.id : null;
    } catch (postErr) {
      // Someone else (another process, the arr's own UI) may have created it
      // since the read, or this POST landed and only its answer was lost.
      const again = tagIdIn(await arrFetch<unknown>(cfg, "/api/v3/tag").catch(() => null), wanted);
      if (again !== null) return again;
      throw postErr;
    }
  } catch (err) {
    console.warn("[arr] requester-tag ensure failed (proceeding untagged):", sanitizeForLog(err instanceof Error ? err.message : String(err)));
    return null;
  }
}

// Resolve the requester's tag id(s) for an instance. Looks the user up for a
// human-readable label; returns [] on any failure (⇒ the add stays untagged).
async function resolveRequesterTagIds(cfg: ArrCfgFull, requesterUserId: string | null | undefined): Promise<number[]> {
  if (!requesterUserId) return [];
  try {
    const user = await prisma.user.findUnique({ where: { id: requesterUserId }, select: { name: true, email: true } });
    const id = await ensureArrTag(cfg, arrRequesterTagLabel(user?.name, user?.email, requesterUserId));
    return id != null ? [id] : [];
  } catch (err) {
    console.warn("[arr] requester-tag resolve failed (proceeding untagged):", sanitizeForLog(err instanceof Error ? err.message : String(err)));
    return [];
  }
}

// ── the POST ─────────────────────────────────────────────────────────────────

function isDuplicate(err: unknown): boolean {
  if (err instanceof ArrResponseError) {
    return err.status === 400 && /already (been )?added/i.test(err.body);
  }
  return /already (been )?added/i.test(String(err));
}

/**
 * Radarr's `MoviePathValidator` / Sonarr's `SeriesPathValidator` reject an add
 * with a 400 when the `Title (Year)` folder the item would use is already
 * occupied by a *different* item (different tmdb/tvdb id) — two genuinely
 * distinct films/shows that map to the same folder name. This is NOT a
 * duplicate: the requested item still needs to be added under its own id.
 *
 * Returns the colliding path Radarr/Sonarr reported so the caller can retry
 * with an id-disambiguated path; null when the error is anything else. Prefers
 * the structured body (stable `errorCode` + `path` placeholder) and falls back
 * to the human-readable message.
 */
function pathCollisionTarget(err: unknown): string | null {
  if (!(err instanceof ArrResponseError) || err.status !== 400) return null;
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(err.body);
  } catch {
    // body wasn't JSON — fall through to the message regex
  }
  if (Array.isArray(parsed)) {
    for (const entry of parsed) {
      const failure = asRecord(entry);
      if (!failure || (failure.errorCode !== "MoviePathValidator" && failure.errorCode !== "SeriesPathValidator")) continue;
      const p = asRecord(failure.formattedMessagePlaceholderValues)?.path ?? failure.attemptedValue;
      if (typeof p === "string" && p.length > 0) return p;
      break;
    }
  }
  const m = err.body.match(/Path '([^']+)' is already configured for an existing/);
  return m && m[1] ? m[1] : null;
}

/**
 * The add's POST, shared by Radarr and Sonarr. "Already added" runs the caller's
 * duplicate remediation. A *different* title (another tmdb/tvdb id) occupying the
 * `Title (Year)` folder this one would use is retried ONCE at an id-tagged path
 * (`<path> {tmdb-<id>}` / `{tvdb-<id>}`), so two genuinely distinct same-title
 * items coexist instead of the request hard-failing. That path can only collide
 * if this very title is already there — a real duplicate, which surfaces as
 * "already added". Anything else is rethrown.
 */
async function postWithCollisionRetry(
  post: (pathOverride?: string) => Promise<unknown>,
  idFolderToken: string,
  onDuplicate: () => Promise<void>,
): Promise<void> {
  try {
    await post();
  } catch (err) {
    if (isDuplicate(err)) return onDuplicate();
    const collidedPath = pathCollisionTarget(err);
    if (!collidedPath) throw err;
    try {
      await post(`${collidedPath} ${idFolderToken}`);
    } catch (retryErr) {
      if (isDuplicate(retryErr)) return onDuplicate();
      throw retryErr;
    }
  }
}

// ── the shared flow ──────────────────────────────────────────────────────────

/** What one service contributes to addToArr. */
interface AddPlan<Row> {
  label: "Radarr" | "Sonarr";
  service: "radarr" | "sonarr";
  path: "/api/v3/movie" | "/api/v3/series";
  /** The title to add, verified against the request; throws the service's own not-found error. */
  lookup: (cfg: ArrCfgFull) => Promise<Row>;
  /** Whether it is out yet — decides the add-time search. */
  released: (row: Row) => boolean;
  /** The lookup's identity fields, sent back as they came (never the whole row). */
  identity: (row: Row) => Record<string, unknown>;
  /** The instance's own optional fields — omitted when unconfigured, byte-identical to older adds. */
  instanceOptions: (cfg: ArrCfgFull) => Record<string, unknown>;
  addOptions: (released: boolean) => Record<string, unknown>;
  /** The arr's own id folder token for the collision retry. */
  idFolderToken: (row: Row) => string;
  /** Logged when the arr already holds the title. */
  duplicateWarning: string;
  /** The request's tmdbId, logged with the duplicate warning. */
  tmdbId: number;
  /** Re-monitor (and search) an existing unmonitored entry; best-effort, never throws. */
  remediate: (cfg: ArrCfgFull, row: Row, released: boolean) => Promise<void>;
}

/** Up to this many entries of a root-folder or profile list are read for the first usable one (guardrail 5i). */
const MAX_DEFAULTS_SCAN = 1_000;

// The first root folder with a path — the instance default when none is configured.
async function firstRootFolderPath(cfg: ArrCfgFull): Promise<string | null> {
  const raw = await arrFetch<unknown>(cfg, "/api/v3/rootfolder");
  if (!Array.isArray(raw)) return null;
  for (let i = 0; i < raw.length && i < MAX_DEFAULTS_SCAN; i++) {
    const path = asRecord(raw[i])?.path;
    if (typeof path === "string" && path.length > 0) return path;
  }
  return null;
}

// The first quality profile with a usable id.
async function firstQualityProfileId(cfg: ArrCfgFull): Promise<number | null> {
  const raw = await arrFetch<unknown>(cfg, "/api/v3/qualityprofile");
  if (!Array.isArray(raw)) return null;
  for (let i = 0; i < raw.length && i < MAX_DEFAULTS_SCAN; i++) {
    const id = posInt(asRecord(raw[i])?.id);
    if (id !== null) return id;
  }
  return null;
}

async function addToArr<Row>(
  plan: AddPlan<Row>,
  variant: ArrVariant,
  qualityProfileIdOverride: number | undefined,
  requesterUserId: string | null | undefined,
  progress: AddProgress | undefined,
): Promise<Row> {
  const cfg = await getCfg(plan.service, variant);
  if (!cfg) throw new Error(instanceLabel(plan.label, variant) + " is not configured");

  // An explicit override (admin "approve with profile X") wins over the
  // configured default; only fetch the instance's profiles when neither is set.
  // ONE normalized value decides both: an override of 0 or NaN used to fetch the
  // profiles (it is falsy) and then POST itself anyway (it survives `??`), which
  // Radarr/Sonarr refuse with a 400.
  const override = posInt(qualityProfileIdOverride) ?? undefined;
  const needProfiles = override === undefined && cfg.qualityProfileId === undefined;
  const [row, fallbackRootFolder, fallbackProfileId] = await Promise.all([
    plan.lookup(cfg),
    cfg.rootFolder ? Promise.resolve(null) : firstRootFolderPath(cfg),
    needProfiles ? firstQualityProfileId(cfg) : Promise.resolve(null),
  ]);

  // getCfg normalizes an empty rootFolder to undefined, so `??` falls through to
  // the instance's own first root folder exactly when the guard above fetched it.
  const rootFolderPath = cfg.rootFolder ?? fallbackRootFolder;
  if (!rootFolderPath) throw new Error(`${plan.label}: no root folders configured`);
  const qualityProfileId = override ?? cfg.qualityProfileId ?? fallbackProfileId;
  if (qualityProfileId == null) throw new Error(`${plan.label}: no quality profiles configured`);
  const released = plan.released(row);
  const tagIds = await resolveRequesterTagIds(cfg, requesterUserId);

  // Send only the fields listed here, not the whole lookup row (~30 untyped
  // fields), so a future arr that rejects unexpected fields can't break adds.
  // `pathOverride` is set only on the collision retry.
  const post = (pathOverride?: string) =>
    arrFetch<unknown>(cfg, plan.path, {
      method: "POST",
      body: JSON.stringify({
        ...plan.identity(row),
        rootFolderPath,
        ...(pathOverride ? { path: pathOverride } : {}),
        qualityProfileId,
        ...plan.instanceOptions(cfg),
        ...(tagIds.length ? { tags: tagIds } : {}),
        monitored: true,
        addOptions: plan.addOptions(released),
      }),
    });

  if (progress) progress.sent = true;
  await postWithCollisionRetry(post, plan.idFolderToken(row), async () => {
    console.warn(plan.duplicateWarning, { tmdbId: plan.tmdbId });
    await plan.remediate(cfg, row, released);
  });
  return row;
}

// ── Radarr ───────────────────────────────────────────────────────────────────

// What the add reads off Radarr's lookup row. Everything else it sends back
// (title, slug, images) goes as Radarr sent it.
const RadarrLookupMovie = v.object({
  tmdbId: v.int(),
  year: v.optional(v.nullable(v.number())),
  digitalRelease: v.optional(v.nullable(v.string())),
  physicalRelease: v.optional(v.nullable(v.string())),
  status: v.optional(v.nullable(v.string())),
});
type RadarrAddRow = { raw: ArrRecord; movie: { tmdbId: number; year: number | null; dates: Date[]; status: string | null } };

async function lookupMovieForAdd(cfg: ArrCfgFull, tmdbId: number): Promise<RadarrAddRow> {
  const raw = await arrFetch<unknown>(cfg, `/api/v3/movie/lookup?term=tmdb:${tmdbId}`);
  const movies = Array.isArray(raw) ? raw : [];
  if (!movies.length) throw new Error(`Radarr: no movie found for tmdbId ${tmdbId}`);
  // Radarr's `tmdb:` lookup degrades to a fuzzy *title* search when the term
  // isn't recognized as an id form, so a non-empty result list can be entirely
  // unrelated films — taking [0] blindly adds the wrong movie to the library.
  // Match on the requested id (every read path does). A lone row is trusted
  // only when it doesn't name ANOTHER title: one carrying a different tmdbId
  // is a degraded search hit, and adding it puts the wrong movie in the
  // library (the same rule Sonarr's lookup follows).
  const rows = movies.flatMap((m) => {
    const r = asRecord(m);
    return r ? [r] : [];
  });
  const picked = pickSeriesByTmdbId(rows, tmdbId);
  const checked = picked ? check(RadarrLookupMovie, picked) : null;
  if (!picked || !checked?.ok) throw new Error(`Radarr: lookup for tmdbId ${tmdbId} returned no matching movie`);
  const { year, digitalRelease, physicalRelease, status } = checked.value;
  const dates = [digitalRelease, physicalRelease].flatMap((d) => (d ? [new Date(d)] : []));
  return { raw: picked, movie: { tmdbId: checked.value.tmdbId, year: year ?? null, dates, status: status ?? null } };
}

// Also trust Radarr's own computed `status === "released"`: upstream sets it
// when a home date is past OR when a title has NO home dates but left cinemas
// 90+ days ago — exactly the metadata state the year heuristic mishandled (a
// current-year release missing type-4/5 dates read as unreleased and the
// add-time search never fired).
function movieReleased({ movie }: RadarrAddRow, now = new Date()): boolean {
  return (
    movie.dates.some((d) => d <= now) ||
    movie.status === "released" ||
    (movie.dates.length === 0 && movie.year !== null && movie.year > 0 && movie.year < now.getFullYear())
  );
}

// Duplicate remediation: "already been added" used to read as pure success —
// but a pre-existing UNMONITORED, file-less entry is never auto-grabbed
// (Radarr's decision engine rejects unmonitored movies on RSS and automatic
// search), so the approved request sat APPROVED forever while approve
// reported success. Best-effort: re-monitor + search; any failure degrades to
// the old warn-and-skip.
async function remediateExistingMovie(cfg: ArrCfgFull, tmdbId: number, released: boolean): Promise<void> {
  try {
    const row = await findRadarrMovie(cfg, tmdbId);
    const id = posInt(row?.id);
    if (!row || id === null || row.hasFile === true || row.monitored === true) return;
    // Radarr's PUT expects the full MovieResource — round-trip the row with
    // only the monitored flag flipped.
    await arrFetch<unknown>(cfg, `/api/v3/movie/${id}`, {
      method: "PUT",
      body: JSON.stringify({ ...row, monitored: true }),
    });
    if (released) {
      await arrFetch<unknown>(cfg, "/api/v3/command", {
        method: "POST",
        body: JSON.stringify({ name: "MoviesSearch", movieIds: [id] }),
      });
    }
  } catch (remErr) {
    console.warn("[arr] existing-movie re-monitor failed (leaving as-is):", arrErrorMessage(remErr));
  }
}

function radarrAddPlan(tmdbId: number): AddPlan<RadarrAddRow> {
  return {
    label: "Radarr",
    service: "radarr",
    path: "/api/v3/movie",
    lookup: (cfg) => lookupMovieForAdd(cfg, tmdbId),
    released: (row) => movieReleased(row),
    identity: ({ raw, movie }) => ({
      tmdbId: movie.tmdbId,
      title: raw.title,
      year: raw.year,
      titleSlug: raw.titleSlug,
      images: raw.images,
    }),
    // Only when the instance configured one — omitting the field preserves
    // Radarr's own default, byte-identical to pre-feature adds.
    instanceOptions: (cfg) => (cfg.minimumAvailability ? { minimumAvailability: cfg.minimumAvailability } : {}),
    addOptions: (released) => ({ searchForMovie: released }),
    // Radarr's own `{tmdb-<id>}` folder token.
    idFolderToken: ({ movie }) => `{tmdb-${movie.tmdbId}}`,
    duplicateWarning: "[arr] movie already in Radarr — re-checking its monitored state",
    tmdbId,
    remediate: (cfg, _row, released) => remediateExistingMovie(cfg, tmdbId, released),
  };
}

export async function addMovieToRadarr(tmdbId: number, variant: ArrVariant = "", qualityProfileIdOverride?: number, requesterUserId?: string | null, progress?: AddProgress): Promise<void> {
  await addToArr(radarrAddPlan(tmdbId), variant, qualityProfileIdOverride, requesterUserId, progress);
}

// ── Sonarr ───────────────────────────────────────────────────────────────────

const SonarrLookupSeries = v.object({
  tvdbId: v.int(),
  year: v.optional(v.nullable(v.number())),
  firstAired: v.optional(v.nullable(v.string())),
  status: v.optional(v.nullable(v.string())),
  seasons: v.array(v.unknown()),
});
type SonarrAddRow = { raw: ArrRecord; tvdbId: number; seasons: ArrRecord[]; released: boolean };

// Every season monitored except specials — the add's and the re-monitor's rule.
// null when the list holds something that isn't a season.
function monitorRegularSeasons(seasons: readonly unknown[]): ArrRecord[] | null {
  const out: ArrRecord[] = [];
  for (const x of seasons) {
    const s = asRecord(x);
    if (!s) return null;
    out.push({ ...s, monitored: typeof s.seasonNumber === "number" && s.seasonNumber > 0 });
  }
  return out;
}

async function lookupSeriesForAdd(cfg: ArrCfgFull, tmdbId: number): Promise<SonarrAddRow> {
  // Same fuzzy-title-search hazard as the Radarr add: an unmapped tmdb id makes
  // Sonarr fall back to a SkyHook title search, so results[0] can be an unrelated
  // show — which would be added to the library AND returned as this request's
  // tvdbId, so the webhook later marks the wrong download AVAILABLE. Resolved
  // through the same guard as every read path (pickSeriesByTmdbId), and with no
  // verified match, TMDB's own TVDB cross-reference (a new show Sonarr can't
  // resolve by tmdb id yet — see resolveTmdbToTvdb), so a series added this way
  // is also found by the download check, the issue flow and the arr-state
  // diagnostic.
  const { series, candidates, crossRefTvdbId } = await resolveSonarrSeries(cfg, tmdbId);
  if (!series) {
    const tried = crossRefTvdbId != null
      ? `; TMDB's TVDB id ${crossRefTvdbId} didn't match a Sonarr series either`
      : "; no TVDB id available from TMDB to fall back on";
    throw new Error(
      candidates
        ? `Sonarr: lookup for tmdbId ${tmdbId} returned no matching series${tried}`
        : `Sonarr: no series found for tmdbId ${tmdbId}${tried}`,
    );
  }
  const checked = check(SonarrLookupSeries, series);
  const tvdbId = checked.ok ? posInt(checked.value.tvdbId) : null;
  const seasons = checked.ok ? monitorRegularSeasons(checked.value.seasons) : null;
  if (!checked.ok || tvdbId === null || !seasons) {
    throw new Error(`Sonarr: lookup for tmdbId ${tmdbId} returned an unusable series`);
  }
  // firstAired is authoritative; without it, Sonarr's own status ("upcoming"
  // vs continuing/ended) beats the year heuristic, which read every
  // current-year show as unaired and skipped the add-time search.
  const { firstAired, status, year } = checked.value;
  const now = new Date();
  const released = firstAired
    ? new Date(firstAired) <= now
    : (status ? status !== "upcoming" : typeof year === "number" && year < now.getFullYear());
  return { raw: series, tvdbId, seasons, released };
}

// Sonarr twin of the Radarr duplicate remediation: an existing UNMONITORED entry
// is never auto-grabbed, so re-monitor (regular seasons only, matching the add)
// + search, degrading to warn-and-skip on any failure.
async function remediateExistingSeries(cfg: ArrCfgFull, variant: ArrVariant, tvdbId: number, released: boolean): Promise<void> {
  try {
    const row = await findSonarrSeries(cfg, tvdbId);
    const id = posInt(row?.id);
    if (!row || id === null || row.monitored === true) return;
    const seasons = monitorRegularSeasons(Array.isArray(row.seasons) ? row.seasons : []);
    if (!seasons) throw new Error("Sonarr sent an unusable season list");
    await arrFetch<unknown>(cfg, `/api/v3/series/${id}`, {
      method: "PUT",
      body: JSON.stringify({ ...row, monitored: true, seasons }),
    });
    if (released) {
      // The Missing plan (SeasonSearch for a fully-missing season, EpisodeSearch for the
      // rest), NOT SeriesSearch: this is a missing-only action — the add path's own
      // searchForMissingEpisodes is missing-only too — and SeriesSearch would also hunt
      // upgrades for every episode already on disk. Dynamic import: arr-missing-data
      // imports arr.ts, which re-exports this module. Nothing missing is fine.
      const { searchMissing, NothingMissingError } = await import("./arr-missing-data");
      await searchMissing("sonarr", variant === "hd" ? "" : variant, id, new Date()).catch((e) => {
        if (!(e instanceof NothingMissingError)) throw e;
      });
    }
  } catch (remErr) {
    console.warn("[arr] existing-series re-monitor failed (leaving as-is):", arrErrorMessage(remErr));
  }
}

function sonarrAddPlan(tmdbId: number, variant: ArrVariant): AddPlan<SonarrAddRow> {
  return {
    label: "Sonarr",
    service: "sonarr",
    path: "/api/v3/series",
    lookup: (cfg) => lookupSeriesForAdd(cfg, tmdbId),
    released: (row) => row.released,
    identity: ({ raw, tvdbId, seasons }) => ({
      tvdbId,
      title: raw.title,
      year: raw.year,
      titleSlug: raw.titleSlug,
      images: raw.images,
      seasons,
    }),
    // Sonarr v3 only (v4 removed language profiles and its settings UI never
    // offers one) — omitted when unconfigured, byte-identical to old adds.
    instanceOptions: (cfg) => (cfg.languageProfileId ? { languageProfileId: cfg.languageProfileId } : {}),
    addOptions: (released) => ({ searchForMissingEpisodes: released }),
    // Sonarr's own `{tvdb-<id>}` folder token.
    idFolderToken: ({ tvdbId }) => `{tvdb-${tvdbId}}`,
    duplicateWarning: "[arr] series already in Sonarr — re-checking its monitored state",
    tmdbId,
    remediate: (cfg, row, released) => remediateExistingSeries(cfg, variant, row.tvdbId, released),
  };
}

/** Adds the series and answers its tvdbId — the request stores it. */
export async function addSeriesToSonarr(tmdbId: number, variant: ArrVariant = "", qualityProfileIdOverride?: number, requesterUserId?: string | null, progress?: AddProgress): Promise<number> {
  return (await addToArr(sonarrAddPlan(tmdbId, variant), variant, qualityProfileIdOverride, requesterUserId, progress)).tvdbId;
}
