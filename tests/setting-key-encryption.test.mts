// The encryption gate for per-instance Setting keys — isSensitiveSettingKey's
// two shape regexes, cross-checked against the real key GENERATORS rather than
// against hand-written strings.
//
// Why this file exists: tests/settings-sensitive-keys.test.mts pins the static
// SETTINGS_SENSITIVE_KEYS array, and that is where its coverage stops. Neither
// ARR_INSTANCE_SECRET_RE nor MEDIA_INSTANCE_SECRET_RE nor isSensitiveSettingKey
// itself is exercised anywhere — yet those two regexes are the ENTIRE encryption
// gate for admin-defined instance slugs, which by construction cannot be
// enumerated in the static list (guardrails 32 and 35 both say so explicitly).
//
// The failure mode is silent and one-directional. isSensitiveSettingKey is what
// the Prisma extension in src/lib/prisma.ts consults to decide whether to
// encrypt on write and decrypt on read (guardrail 7a). A key the regex does not
// match is written in PLAINTEXT — a Radarr API key, a webhook secret, a Plex
// admin token sitting readable in the database — and nothing anywhere reports
// it. There is no error, no type change, and the app keeps working perfectly,
// because a plaintext value round-trips through the extension unchanged. The
// only symptom is at rest, in a table nobody reads by hand.
//
// The drift that would cause it is small and plausible: the regexes encode an
// assumption about how a slug becomes a key segment — first character
// uppercased, the rest verbatim (`anime` → `Anime`, `4k` → `4k` unchanged, which
// is what preserves every legacy radarr4k* key). That rule lives in
// instanceKeySegment(), in TWO separate modules, and the regexes are hand-written
// copies of its output shape sitting in a third. Change the capitalization rule,
// add a separator, allow an uppercase or hyphenated slug — and the generators
// keep producing valid keys while the regexes quietly stop matching them.
//
// So rather than assert against literal strings, this generates every key the
// real arrSettingKey/plexSettingKey/jellyfinSettingKey produce, for realistic
// slugs across the full field union of each service, and asserts the verdict is
// correct for all of them. A field added to any of those unions is covered
// automatically; a capitalization change breaks the cross-check immediately.
//
// The negative direction matters just as much and is the more surprising half:
// over-matching would encrypt a URL, a root folder, a library list or a strip
// prefix, and CLAUDE.md calls those out as deliberately plaintext. An
// over-broad regex there is not merely wasteful — settings written before the
// change read back as ciphertext-shaped garbage.
import { test } from "node:test";
import assert from "node:assert/strict";

import type { ArrService, ArrSettingField } from "../src/lib/arr-instances.ts";
import type { JellyfinSettingField, PlexSettingField } from "../src/lib/media-instances.ts";

// All three are zero-import pure leaves, so a plain static import would work —
// dynamic import only to match the house style used across the suite.
const {
  SETTINGS_SENSITIVE_KEYS,
  isSensitiveSettingKey,
} = await import("../src/lib/settings-sensitive-keys.ts");
const { arrSettingKey, isValidInstanceSlug } = await import("../src/lib/arr-instances.ts");
const { jellyfinSettingKey, plexSettingKey, isValidMediaInstanceSlug } =
  await import("../src/lib/media-instances.ts");

// The full field unions, mirrored from the generator modules' exported types.
// Keeping them explicit (rather than deriving) is the point: if a field is added
// upstream and not added here, the "every field is covered" test below fails and
// names it, instead of the new field silently escaping classification.
const ARR_FIELDS: ArrSettingField[] = ["Url", "ApiKey", "RootFolder", "QualityProfileId", "WebhookSecret"];
const ARR_SECRET_FIELDS = new Set<ArrSettingField>(["ApiKey", "WebhookSecret"]);

const PLEX_FIELDS: PlexSettingField[] = [
  "ServerUrl", "AdminToken", "AdminEmail", "ServerReachable",
  "Libraries", "PathStripPrefix", "MoviePathStripPrefix", "TvPathStripPrefix",
];
const PLEX_SECRET_FIELDS = new Set<PlexSettingField>(["AdminToken"]);

const JELLYFIN_FIELDS: JellyfinSettingField[] = [
  "Url", "ApiKey", "Libraries", "PathStripPrefix",
  "MoviePathStripPrefix", "TvPathStripPrefix", "RestrictSignIn",
];
const JELLYFIN_SECRET_FIELDS = new Set<JellyfinSettingField>(["ApiKey"]);

// "" is the default instance, "4k" the grandfathered legacy one, the rest are
// representative admin-defined slugs (including the digit-bearing and
// max-length shapes NAMED_SLUG_RE permits).
const ARR_SLUGS = ["", "4k", "anime", "kids", "uhd2", "x", "abcdefghijklmnopqrstuvwx"];
const MEDIA_SLUGS = ["", "remote", "backup", "attic2", "z", "abcdefghijklmnopqrstuvwx"];

const ARR_SERVICES: ArrService[] = ["radarr", "sonarr"];

// ── the generators still produce what the regexes assume ────────────────────

test("every slug used here is one the validators actually accept", () => {
  // A slug the registry would reject proves nothing about the live gate.
  for (const s of ARR_SLUGS) {
    assert.ok(isValidInstanceSlug(s), `arr slug ${JSON.stringify(s)} is rejected by isValidInstanceSlug`);
  }
  for (const s of MEDIA_SLUGS) {
    assert.ok(isValidMediaInstanceSlug(s), `media slug ${JSON.stringify(s)} is rejected by isValidMediaInstanceSlug`);
  }
});

test("the default and legacy-4K slugs still generate the exact legacy Setting keys", () => {
  // Guardrails 32/35: a single-server, single-instance deployment must not be
  // able to observe that the multi-instance generalization happened. If these
  // spellings drift, existing rows are orphaned and the app reads unset config.
  assert.equal(arrSettingKey("radarr", "", "ApiKey"), "radarrApiKey");
  assert.equal(arrSettingKey("radarr", "4k", "ApiKey"), "radarr4kApiKey");
  assert.equal(arrSettingKey("sonarr", "4k", "WebhookSecret"), "sonarr4kWebhookSecret");
  assert.equal(plexSettingKey("", "AdminToken"), "plexAdminToken");
  assert.equal(jellyfinSettingKey("", "ApiKey"), "jellyfinApiKey");
  // …and a named slug capitalizes exactly its first character.
  assert.equal(arrSettingKey("radarr", "anime", "ApiKey"), "radarrAnimeApiKey");
  assert.equal(plexSettingKey("remote", "AdminToken"), "plexRemoteAdminToken");
  assert.equal(jellyfinSettingKey("remote", "ApiKey"), "jellyfinRemoteApiKey");
});

// ── the gate: generated keys are classified correctly, both directions ──────

interface Case { key: string; secret: boolean; label: string }

function arrCases(): Case[] {
  const out: Case[] = [];
  for (const service of ARR_SERVICES) {
    for (const slug of ARR_SLUGS) {
      for (const field of ARR_FIELDS) {
        out.push({
          key: arrSettingKey(service, slug, field),
          secret: ARR_SECRET_FIELDS.has(field),
          label: `arrSettingKey(${service}, ${JSON.stringify(slug)}, ${field})`,
        });
      }
    }
  }
  return out;
}

function mediaCases(): Case[] {
  const out: Case[] = [];
  for (const slug of MEDIA_SLUGS) {
    for (const field of PLEX_FIELDS) {
      out.push({
        key: plexSettingKey(slug, field),
        secret: PLEX_SECRET_FIELDS.has(field),
        label: `plexSettingKey(${JSON.stringify(slug)}, ${field})`,
      });
    }
    for (const field of JELLYFIN_FIELDS) {
      out.push({
        key: jellyfinSettingKey(slug, field),
        secret: JELLYFIN_SECRET_FIELDS.has(field),
        label: `jellyfinSettingKey(${JSON.stringify(slug)}, ${field})`,
      });
    }
  }
  return out;
}

const ALL_CASES = [...arrCases(), ...mediaCases()];

test("every generated Radarr/Sonarr instance key is classified correctly (guardrail 32)", () => {
  const wrong = arrCases().filter((c) => isSensitiveSettingKey(c.key) !== c.secret);
  assert.deepEqual(
    wrong.map((c) => `${c.label} → "${c.key}" expected sensitive=${c.secret}, got ${!c.secret}`),
    [],
    "ARR_INSTANCE_SECRET_RE disagrees with arrSettingKey. A false NEGATIVE stores a Radarr/Sonarr API key or " +
      "webhook secret in plaintext (guardrail 7a); a false POSITIVE encrypts a URL or root folder, and every " +
      "row written before the change reads back as garbage.",
  );
});

test("every generated Plex/Jellyfin instance key is classified correctly (guardrail 35)", () => {
  const wrong = mediaCases().filter((c) => isSensitiveSettingKey(c.key) !== c.secret);
  assert.deepEqual(
    wrong.map((c) => `${c.label} → "${c.key}" expected sensitive=${c.secret}, got ${!c.secret}`),
    [],
    "MEDIA_INSTANCE_SECRET_RE disagrees with plexSettingKey/jellyfinSettingKey. CLAUDE.md pins the split " +
      "exactly: it matches plex<Slug>AdminToken and jellyfin<Slug>ApiKey, and must NOT match ServerUrl, " +
      "AdminEmail, Libraries, *PathStripPrefix or RestrictSignIn.",
  );
});

test("the matrix is non-vacuous — it covers both verdicts at real scale", () => {
  const secrets = ALL_CASES.filter((c) => c.secret);
  const plaintext = ALL_CASES.filter((c) => !c.secret);
  assert.ok(ALL_CASES.length > 150, `only ${ALL_CASES.length} generated keys — the matrix collapsed`);
  assert.ok(secrets.length > 30, `only ${secrets.length} secret keys generated`);
  assert.ok(plaintext.length > 60, `only ${plaintext.length} plaintext keys generated`);
  // Every generated key must be a clean camelCase identifier — the shape both
  // regexes are written against.
  const malformed = ALL_CASES.filter((c) => !/^[a-z][A-Za-z0-9]*$/.test(c.key));
  assert.deepEqual(malformed.map((c) => `${c.label} → ${c.key}`), []);
});

test("every field of every service union is exercised — a new field cannot escape classification", () => {
  // Guards the mirrored unions above. If a field is added to ArrSettingField /
  // PlexSettingField / JellyfinSettingField and not added here, its keys are
  // never generated and the classification tests pass without covering it.
  const suffixes = new Set(ALL_CASES.map((c) => c.key.replace(/^(radarr|sonarr|plex|jellyfin)/, "")));
  for (const field of [...ARR_FIELDS, ...PLEX_FIELDS, ...JELLYFIN_FIELDS]) {
    assert.ok(
      [...suffixes].some((s) => s === field || s.endsWith(field)),
      `field ${field} never appears in a generated key`,
    );
  }
  // The unions must still match the generators' real accepted values: a typo
  // here would silently drop a field from the matrix.
  assert.equal(ARR_FIELDS.length, 5, "ArrSettingField has 5 members — update the mirror deliberately");
  assert.equal(PLEX_FIELDS.length, 8, "PlexSettingField has 8 members — update the mirror deliberately");
  assert.equal(JELLYFIN_FIELDS.length, 7, "JellyfinSettingField has 7 members — update the mirror deliberately");
});

// ── the boundaries the module's own comments promise ────────────────────────

test("non-secret instance settings stay plaintext — the regexes cannot reach them", () => {
  // Called out by name in settings-sensitive-keys.ts and in guardrails 32/35.
  const mustBePlaintext = [
    "radarrUrl", "radarrRootFolder", "radarrQualityProfileId",
    "radarr4kUrl", "radarrAnimeRootFolder", "sonarrAnimeQualityProfileId",
    "plexServerUrl", "plexAdminEmail", "plexLibraries", "plexServerReachable",
    "plexRemoteServerUrl", "plexRemotePathStripPrefix", "plexRestrictSignIn",
    "jellyfinUrl", "jellyfinLibraries", "jellyfinRestrictSignIn",
    "jellyfinRemoteUrl", "jellyfinRemoteMoviePathStripPrefix",
    // Registry JSON blobs: which instances exist, not their credentials.
    "arrRadarrInstances", "arrSonarrInstances", "plexInstances", "jellyfinInstances",
  ];
  const wrongly = mustBePlaintext.filter((k) => isSensitiveSettingKey(k));
  assert.deepEqual(wrongly, [], "these Setting keys are deliberately plaintext — encrypting them corrupts existing rows");
});

test("near-miss keys do not accidentally match — the regexes are anchored", () => {
  // Both regexes are fully anchored (^…$). An unanchored variant would match
  // any key merely CONTAINING the shape, which is how an over-broad gate
  // usually arrives.
  const notSecrets = [
    "myRadarrApiKeyBackup",   // suffix past the anchor
    "legacyRadarrApiKey",     // prefix before the anchor
    "radarrApiKeyOld",
    "plexAdminTokenLegacy",
    "jellyfinApiKeyV2",
    "radarrapikey",           // wrong case — not a key any generator emits
    "RadarrApiKey",           // leading capital — likewise
  ];
  const matched = notSecrets.filter((k) => isSensitiveSettingKey(k));
  assert.deepEqual(
    matched,
    [],
    "an unanchored regex matches keys no generator produces. Harmless for a key that does not exist — but it " +
      "signals the anchors were dropped, and the same edit is what lets a non-secret field start matching.",
  );
});

test("every statically-listed sensitive key is still classified sensitive", () => {
  // The static set and the regexes are OR'd, so this cannot fail today — it
  // fails the moment someone "simplifies" isSensitiveSettingKey into
  // regex-only, which would silently drop every non-instance credential
  // (smtpPassword, resendApiKey, vapidPrivateKey, discordBotToken, …).
  const dropped = SETTINGS_SENSITIVE_KEYS.filter((k) => !isSensitiveSettingKey(k));
  assert.deepEqual(dropped, [], "a statically-listed credential is no longer gated — it would be stored plaintext");

  // And spot-check the ones the regexes could NEVER cover, so the test states
  // plainly why the static list has to stay.
  for (const k of ["smtpPassword", "resendApiKey", "vapidPrivateKey", "discordBotToken", "apnsRelayKey", "trashGithubToken"]) {
    assert.ok(SETTINGS_SENSITIVE_KEYS.includes(k), `${k} must remain in the static list — no regex shape covers it`);
    assert.ok(isSensitiveSettingKey(k), `${k} is not gated`);
  }
});

test("isSensitiveSettingKey is total — junk input is a plain false, never a throw", () => {
  // The Prisma extension calls this on EVERY Setting read and write, including
  // keys written by older versions and by hand. A throw here would take down
  // every settings read at once.
  for (const junk of ["", " ", "radarr", "plex", "4k", "___", "a".repeat(500), "radarr$ApiKey", "plex-remote-AdminToken"]) {
    assert.equal(typeof isSensitiveSettingKey(junk), "boolean", `isSensitiveSettingKey(${JSON.stringify(junk)}) is not a boolean`);
  }
});
