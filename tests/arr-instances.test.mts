// Unit tests for Radarr/Sonarr instance→Setting-key derivation and the pure
// routing predicate (src/lib/arr-instances.ts). A regression in the key mapping
// silently points config at the wrong (or a non-existent) instance, which the
// reader treats as "not configured"; a regression in routing sends a request to
// the wrong instance. Both are worth pinning down.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  arrSettingKey,
  variantToInstanceKey,
  instanceKeySegment,
  isValidInstanceSlug,
  isAnimeMedia,
  matchesAutoRoute,
  routeMediaToSlug,
  ARR_SETTING_FIELDS,
  BUILTIN_ARR_INSTANCE_KEYS,
  DEFAULT_ARR_INSTANCE,
  FOURK_ARR_INSTANCE,
  type ArrInstanceConfig,
} from "../src/lib/arr-instances.ts";

test("arrSettingKey derives default and 4K keys (legacy spelling preserved)", () => {
  assert.equal(arrSettingKey("radarr", "", "Url"), "radarrUrl");
  assert.equal(arrSettingKey("radarr", "", "ApiKey"), "radarrApiKey");
  assert.equal(arrSettingKey("radarr", "", "RootFolder"), "radarrRootFolder");
  assert.equal(arrSettingKey("radarr", "", "QualityProfileId"), "radarrQualityProfileId");
  assert.equal(arrSettingKey("radarr", "", "WebhookSecret"), "radarrWebhookSecret");
  // "4k" must NOT be capitalized — "4".toUpperCase() === "4" — so all existing
  // radarr4k*/sonarr4k* Setting rows keep resolving.
  assert.equal(arrSettingKey("radarr", "4k", "Url"), "radarr4kUrl");
  assert.equal(arrSettingKey("sonarr", "4k", "ApiKey"), "sonarr4kApiKey");
  assert.equal(arrSettingKey("radarr", "4k", "WebhookSecret"), "radarr4kWebhookSecret");
  assert.equal(arrSettingKey("sonarr", "", "Url"), "sonarrUrl");
});

test("arrSettingKey camelCases a NAMED instance slug", () => {
  assert.equal(arrSettingKey("radarr", "anime", "Url"), "radarrAnimeUrl");
  assert.equal(arrSettingKey("radarr", "anime", "ApiKey"), "radarrAnimeApiKey");
  assert.equal(arrSettingKey("radarr", "anime", "WebhookSecret"), "radarrAnimeWebhookSecret");
  assert.equal(arrSettingKey("sonarr", "kids", "RootFolder"), "sonarrKidsRootFolder");
  assert.equal(instanceKeySegment(""), "");
  assert.equal(instanceKeySegment("4k"), "4k");
  assert.equal(instanceKeySegment("anime"), "Anime");
});

test("named-instance secret keys match the encryption gate shape", async () => {
  // Guardrail 7a: the derived ApiKey/WebhookSecret keys must be recognized as
  // sensitive so they're encrypted at rest. Cross-check against the actual gate.
  const { isSensitiveSettingKey } = await import("../src/lib/settings-sensitive-keys.ts");
  assert.equal(isSensitiveSettingKey("radarrAnimeApiKey"), true);
  assert.equal(isSensitiveSettingKey("sonarrAnimeWebhookSecret"), true);
  assert.equal(isSensitiveSettingKey("radarr4kApiKey"), true);
  // ...but non-secret instance keys stay plaintext by design.
  assert.equal(isSensitiveSettingKey("radarrAnimeUrl"), false);
  assert.equal(isSensitiveSettingKey("radarrAnimeRootFolder"), false);
  assert.equal(isSensitiveSettingKey("radarrAnimeQualityProfileId"), false);
});

test("variantToInstanceKey maps the legacy variant union", () => {
  assert.equal(variantToInstanceKey("hd"), "");
  assert.equal(variantToInstanceKey("4k"), "4k");
});

test("derived keys match the existing convention for the built-in instances", () => {
  assert.deepEqual([...BUILTIN_ARR_INSTANCE_KEYS], [DEFAULT_ARR_INSTANCE, FOURK_ARR_INSTANCE]);
  for (const inst of BUILTIN_ARR_INSTANCE_KEYS) {
    for (const svc of ["radarr", "sonarr"] as const) {
      const expectedSuffix = inst === "4k" ? "4k" : "";
      assert.equal(arrSettingKey(svc, inst, "Url"), `${svc}${expectedSuffix}Url`);
      assert.equal(arrSettingKey(svc, inst, "ApiKey"), `${svc}${expectedSuffix}ApiKey`);
    }
  }
});

test("isValidInstanceSlug accepts built-ins + named slugs, rejects reserved/malformed", () => {
  assert.equal(isValidInstanceSlug(""), true);
  assert.equal(isValidInstanceSlug("4k"), true);
  assert.equal(isValidInstanceSlug("anime"), true);
  assert.equal(isValidInstanceSlug("kids2"), true);
  // "hd" is reserved (aliases the default) so it can't be a named instance.
  assert.equal(isValidInstanceSlug("hd"), false);
  // Named slugs must be lowercase, start with a letter, no separators.
  assert.equal(isValidInstanceSlug("Anime"), false);
  assert.equal(isValidInstanceSlug("4kanime"), false);
  assert.equal(isValidInstanceSlug("an ime"), false);
  assert.equal(isValidInstanceSlug("anime!"), false);
  assert.equal(isValidInstanceSlug("radarr:anime"), false);
});

test("\"external\" is not a valid named slug: \"external\" + Url is the default instance's ExternalUrl key", () => {
  assert.equal(arrSettingKey("radarr", "external", "Url"), arrSettingKey("radarr", "", "ExternalUrl"), "the collision this rule exists for");
  assert.equal(isValidInstanceSlug("external"), false);
  // A slug that merely starts the same way does not collide.
  assert.equal(isValidInstanceSlug("externals"), true);
  assert.equal(isValidInstanceSlug("ext"), true);
});

test("every accepted slug maps every field to its OWN Setting key — no instance shares a row with another", () => {
  // Every lowercase segment that, capitalized, starts some field name is a
  // candidate prefix collision; plus ordinary slugs and the two built-ins.
  const candidates = new Set<string>(["", "4k", "anime", "kids2", "remote", "url", "apikey", "webhook", "root"]);
  for (const field of ARR_SETTING_FIELDS) {
    for (let i = 1; i < field.length; i++) candidates.add(field.slice(0, i).toLowerCase());
  }
  for (const service of ["radarr", "sonarr"] as const) {
    const owner = new Map<string, string>();
    for (const slug of candidates) {
      if (!isValidInstanceSlug(slug)) continue;
      for (const field of ARR_SETTING_FIELDS) {
        const key = arrSettingKey(service, slug, field);
        const prior = owner.get(key);
        assert.equal(prior, undefined, `${key} is claimed by ${prior} and by ${JSON.stringify(slug)}/${field}`);
        owner.set(key, `${JSON.stringify(slug)}/${field}`);
      }
    }
  }
});

test("isAnimeMedia = Animation genre (16) AND Japanese origin/language", () => {
  assert.equal(isAnimeMedia({ genreIds: [16], originalLanguage: "ja", originCountries: [] }), true);
  assert.equal(isAnimeMedia({ genreIds: [16, 10759], originalLanguage: "en", originCountries: ["JP"] }), true);
  // Western animation: genre 16 but not Japanese.
  assert.equal(isAnimeMedia({ genreIds: [16], originalLanguage: "en", originCountries: ["US"] }), false);
  // Japanese live-action: no genre 16.
  assert.equal(isAnimeMedia({ genreIds: [18], originalLanguage: "ja", originCountries: ["JP"] }), false);
  assert.equal(isAnimeMedia({ genreIds: [], originalLanguage: null, originCountries: [] }), false);
});

test("matchesAutoRoute: AND semantics; empty rule never matches", () => {
  const anime = { genreIds: [16], originalLanguage: "ja", originCountries: ["JP"] };
  const western = { genreIds: [16], originalLanguage: "en", originCountries: ["US"] };
  assert.equal(matchesAutoRoute({ animeOnly: true }, anime), true);
  assert.equal(matchesAutoRoute({ animeOnly: true }, western), false);
  assert.equal(matchesAutoRoute({ genreIds: [16] }, western), true);
  assert.equal(matchesAutoRoute({ originalLanguages: ["ja"] }, anime), true);
  assert.equal(matchesAutoRoute({ originalLanguages: ["ja"] }, western), false);
  // animeOnly AND genreIds — both must hold.
  assert.equal(matchesAutoRoute({ animeOnly: true, genreIds: [99] }, anime), false);
  // Empty / null rules match nothing (never an accidental catch-all).
  assert.equal(matchesAutoRoute({}, anime), false);
  assert.equal(matchesAutoRoute(null, anime), false);
});

test("routeMediaToSlug: first non-default match wins, else default", () => {
  const mk = (slug: string, autoRoute: ArrInstanceConfig["autoRoute"]): ArrInstanceConfig => ({
    slug, name: slug || "Default", restricted: false, serverAll: false, skipLibraryCheck: false, autoRoute,
  });
  const instances = [
    mk("", null),
    mk("anime", { animeOnly: true }),
    mk("kids", { genreIds: [16] }),
  ];
  const anime = { genreIds: [16], originalLanguage: "ja", originCountries: ["JP"] };
  const westernToon = { genreIds: [16], originalLanguage: "en", originCountries: ["US"] };
  const liveAction = { genreIds: [18], originalLanguage: "en", originCountries: ["US"] };
  // anime matches "anime" first (before "kids" which would also match genre 16).
  assert.equal(routeMediaToSlug(instances, anime), "anime");
  // western animation misses animeOnly, falls to "kids" (genre 16).
  assert.equal(routeMediaToSlug(instances, westernToon), "kids");
  // live action matches nothing → default.
  assert.equal(routeMediaToSlug(instances, liveAction), "");
  // The default instance is never auto-matched even if listed first with a rule.
  assert.equal(routeMediaToSlug([mk("", { animeOnly: true })], anime), "");
});
