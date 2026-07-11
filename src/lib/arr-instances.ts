// Radarr/Sonarr instance addressing — the single source of truth for how an
// instance maps to its Setting keys, plus the pure routing predicate that decides
// which instance a request lands on.
//
// An "instance" is identified by a slug string:
//   ""      → the default instance   (Setting keys: radarrUrl, radarrApiKey, …)
//   "4k"    → the legacy 4K instance  (radarr4kUrl, radarr4kApiKey, …)
//   "<name>"→ any named instance      (radarr<Name>Url, radarr<Name>ApiKey, …)
//
// Named slugs capitalize their first character when forming a Setting key
// (radarr + Anime + ApiKey → radarrAnimeApiKey) so the derived key is a clean
// camelCase identifier — which is what the sensitive-key encryption gate
// (settings-sensitive-keys.ts) and its camelCase regex both expect. "4k" is
// unchanged by capitalization ("4".toUpperCase() === "4"), so all existing
// radarr4k*/sonarr4k* keys are preserved verbatim.
//
// PURE — zero imports (no prisma / server-only) so it's unit-testable and usable
// from client components (the settings UI) as well as server routes. The
// server-side registry (which reads the configured instances out of Settings)
// lives in arr-instance-registry.ts and delegates key derivation + routing here.

export type ArrService = "radarr" | "sonarr";

// Instance slug. "" is the default instance; "4k" is the legacy 4K instance; any
// other value is a named instance. Widened from the former closed `"" | "4k"`
// union so N named instances need no re-typing of callers.
export type ArrInstanceKey = string;

export const DEFAULT_ARR_INSTANCE = "";
export const FOURK_ARR_INSTANCE = "4k";

// Built-in slugs that predate the named-instance registry. They keep their fixed
// Setting-key spelling and their special-cased permission handling.
export const BUILTIN_ARR_INSTANCE_KEYS: readonly ArrInstanceKey[] = [
  DEFAULT_ARR_INSTANCE,
  FOURK_ARR_INSTANCE,
];

export type ArrSettingField = "Url" | "ApiKey" | "RootFolder" | "QualityProfileId" | "WebhookSecret";

// Named slugs are lowercase alnum starting with a letter, so the derived Setting
// key is a valid camelCase identifier and can't collide with a built-in field
// name. "" and "4k" are the two grandfathered exceptions.
const NAMED_SLUG_RE = /^[a-z][a-z0-9]{0,23}$/;

export function isValidInstanceSlug(slug: string): boolean {
  if (slug === DEFAULT_ARR_INSTANCE || slug === FOURK_ARR_INSTANCE) return true;
  // "hd" is reserved — getCfg maps it to the default instance ("") for back-compat,
  // so a named instance can't claim it.
  if (slug === "hd") return false;
  return NAMED_SLUG_RE.test(slug);
}

// The Setting-key segment for an instance slug. "" → "", "4k" → "4k", "anime" →
// "Anime". Capitalizing the first char is a no-op for "4k" (preserving legacy
// keys) and yields camelCase for named slugs.
export function instanceKeySegment(instance: ArrInstanceKey): string {
  if (instance === DEFAULT_ARR_INSTANCE) return "";
  return instance.charAt(0).toUpperCase() + instance.slice(1);
}

// e.g. arrSettingKey("radarr", "", "Url")      → "radarrUrl"
//      arrSettingKey("radarr", "4k", "Url")    → "radarr4kUrl"
//      arrSettingKey("radarr", "anime", "Url") → "radarrAnimeUrl"
export function arrSettingKey(service: ArrService, instance: ArrInstanceKey, field: ArrSettingField): string {
  return `${service}${instanceKeySegment(instance)}${field}`;
}

// Bridge from the legacy ArrVariant ("hd" | "4k") to the instance slug. Retained
// so any remaining variant-typed call site keeps compiling during the transition.
export function variantToInstanceKey(variant: "hd" | "4k"): ArrInstanceKey {
  return variant === "4k" ? FOURK_ARR_INSTANCE : DEFAULT_ARR_INSTANCE;
}

// ─── Routing ──────────────────────────────────────────────────────────────────

// A declarative auto-route predicate stored per named instance. A media item
// matches when EVERY specified sub-predicate matches (AND); an empty rule matches
// nothing (so it can never become an accidental catch-all).
export interface ArrAutoRoute {
  animeOnly?: boolean;            // TMDB Animation genre (16) AND Japanese origin/language
  genreIds?: number[];           // matches if the media carries ANY of these TMDB genre ids
  originalLanguages?: string[];  // matches if original_language is one of these (e.g. ["ja"])
}

// Full metadata for one configured instance (the registry entry). Connection
// config (url/apiKey/rootFolder/qualityProfileId/webhookSecret) is NOT here — it
// stays in Setting rows keyed by arrSettingKey. This is the routing/access/display
// metadata that the registry JSON Setting carries.
export interface ArrInstanceConfig {
  slug: ArrInstanceKey;
  name: string;
  // When true, requesting this instance requires an explicit per-user grant (or
  // serverAll, or ADMIN). When false, any user who can request the media type may
  // target it.
  restricted: boolean;
  // Server-wide grant: any requester may target this instance without a per-user
  // grant (the generalization of the legacy request4kAll toggle).
  serverAll: boolean;
  // Availability policy: when true, a request to this instance does NOT short-
  // circuit on an existing shared-library hit (the legacy 4K behavior — the item
  // may exist in the main library but not at this instance's quality). Default
  // false ⇒ honor the shared-library "already available" check like the default
  // instance.
  skipLibraryCheck: boolean;
  // Auto-routing predicate; null ⇒ never auto-selected (manual/explicit only).
  autoRoute: ArrAutoRoute | null;
}

// The minimal TMDB-derived shape the router needs. Kept tiny + explicit so the
// routing logic stays a pure function over a fixture in tests.
export interface RoutableMedia {
  genreIds: number[];
  originalLanguage: string | null;
  originCountries: string[];
}

// Anime detection: TMDB Animation genre (id 16) AND Japanese origin. The
// language/origin filter is what separates anime from Western animation (Pixar,
// etc.) — genre 16 alone is far too noisy.
export function isAnimeMedia(media: RoutableMedia): boolean {
  const isAnimation = media.genreIds.includes(16);
  if (!isAnimation) return false;
  const isJapanese =
    media.originalLanguage === "ja" ||
    media.originCountries.some((c) => c.toUpperCase() === "JP");
  return isJapanese;
}

export function matchesAutoRoute(rule: ArrAutoRoute | null | undefined, media: RoutableMedia): boolean {
  if (!rule) return false;
  let hasPredicate = false;
  if (rule.animeOnly) {
    hasPredicate = true;
    if (!isAnimeMedia(media)) return false;
  }
  if (rule.genreIds && rule.genreIds.length > 0) {
    hasPredicate = true;
    if (!rule.genreIds.some((g) => media.genreIds.includes(g))) return false;
  }
  if (rule.originalLanguages && rule.originalLanguages.length > 0) {
    hasPredicate = true;
    if (!media.originalLanguage || !rule.originalLanguages.includes(media.originalLanguage)) return false;
  }
  return hasPredicate;
}

// First-match-wins routing: returns the slug of the first NON-default instance
// whose autoRoute predicate matches, else the default instance (""). The default
// is never auto-matched — it's the fallback. Callers pass the registry list in
// admin-configured order.
export function routeMediaToSlug(instances: readonly ArrInstanceConfig[], media: RoutableMedia): ArrInstanceKey {
  for (const inst of instances) {
    if (inst.slug === DEFAULT_ARR_INSTANCE) continue;
    if (matchesAutoRoute(inst.autoRoute, media)) return inst.slug;
  }
  return DEFAULT_ARR_INSTANCE;
}
