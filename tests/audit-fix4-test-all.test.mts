// Audit fix C089: Arr System → "Test all" showed a provider whose test only
// WARNED as failed. Settled from the arrs' own source (2026-10-13), not a live
// check — every body below is shaped exactly as the cited source serializes it.
//
//   • The arr decides on NzbDroneValidationFailure.IsWarning alone
//     (src/NzbDrone.Core/Validation/NzbDroneValidationResult.cs — Radarr and
//     Sonarr develop; identical at Radarr v4.7.5.7809 / v5.28.0.10274, Sonarr
//     v4.0.20.3014 / v5.0.0.2569).
//   • Test All: ProviderTestAllResult.ValidationFailures is DECLARED
//     List<ValidationFailure> (src/Radarr.Api.V3/ProviderTestAllResult.cs,
//     src/Sonarr.Api.V3/ProviderTestAllResult.cs, src/Sonarr.Api.V5/Provider/
//     ProviderTestAllResult.cs, every ref above; Radarr v3.2.2.5080 too), filled
//     from `_providerFactory.Test(definition).Errors` — the plain ValidationResult
//     of IndexerBase/DownloadClientBase.Test(), warnings included
//     (ProviderControllerBase.TestAll). The response goes through
//     System.Text.Json with STJson.ApplySerializerSettings (camelCase,
//     WhenWritingNull, JsonStringEnumConverter camelCase, WriteIndented — src/
//     NzbDrone.Common/Serializer/System.Text.Json/STJson.cs), and STJ writes a
//     list element by its declared type: only FluentValidation's
//     ValidationFailure properties (9.5.4: propertyName, errorMessage,
//     attemptedValue, customState, severity, errorCode, formattedMessage*),
//     never the derived isWarning/detailedDescription/infoLink. Nothing in
//     either arr configures STJ polymorphism (PolymorphicWriteOnlyJsonConverter
//     is applied to Command only). A warning — e.g. QBittorrent.cs's
//     `new NzbDroneValidationFailure("MovieCategory", "Category is recommended")
//     { IsWarning = true, ... }` — therefore arrives as {propertyName,
//     errorMessage, severity: "error"}: Severity is FluentValidation's default
//     Error and neither arr ever sets it. A warning's entry is shaped exactly
//     like an error's.
//   • Sonarr v3 (branch v3) is the exception: Nancy + Newtonsoft
//     (src/Sonarr.Http/Extensions/NancyJsonSerializer.cs → src/NzbDrone.Common/
//     Serializer/Json.cs: CamelCasePropertyNamesContractResolver,
//     NullValueHandling.Ignore, StringEnumConverter camelCase), which writes the
//     RUNTIME type — so its Test All entries carry `isWarning`.
//   • A single /test (and a testing save) answers 400 with
//     `STJson.ToJson(validationException.Errors)` (src/Radarr.Http/
//     ErrorManagement/RadarrErrorPipeline.cs, src/Sonarr.Http/ErrorManagement/
//     SonarrErrorPipeline.cs; Radarr v3: `.AsResponse` → STJson.Serialize's
//     `(object)model` cast): the list goes in as `object`, so STJ writes it by
//     its runtime type, List<NzbDroneValidationFailure> (VerifyValidationResult
//     throws `result.Failures`), and every failure carries `isWarning`. A
//     failure without it there is a resource validator's plain ValidationFailure
//     (src/Radarr.Http/REST/RestController.cs ValidateResource), which the arr
//     refuses on outright — an error.
//
// So: Test All on an STJ arr can't tell a warning from an error. A provider
// whose failures carry no flag, none of them a known error, is `uncertain` —
// shown neutrally, pointing at the row's own Test — never a red failure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { projectFailures, projectTestAll, testResultOf, validationFailuresFromBody } from "../src/lib/arr-system.ts";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

// Radarr develop / v5 / v4, Sonarr v4 / v5: POST /api/v3/downloadclient/testall
// → 400 (BadRequest(result), one provider invalid), indented (WriteIndented).
const STJ_TEST_ALL = `[
  {
    "id": 1,
    "isValid": false,
    "validationFailures": [
      {
        "propertyName": "MovieCategory",
        "errorMessage": "Category is recommended",
        "severity": "error"
      }
    ]
  },
  {
    "id": 2,
    "isValid": true,
    "validationFailures": []
  }
]`;

// Sonarr v3 (Newtonsoft, runtime type): the same warning, and a real error.
const SONARR_V3_TEST_ALL = [
  {
    id: 1,
    isValid: false,
    validationFailures: [
      { isWarning: true, detailedDescription: "Sonarr will not attempt to import completed downloads without a category.", propertyName: "TvCategory", errorMessage: "Category is recommended", severity: "error" },
    ],
  },
  {
    id: 2,
    isValid: false,
    validationFailures: [{ isWarning: false, propertyName: "Host", errorMessage: "Unable to connect to SABnzbd", severity: "error" }],
  },
  {
    id: 3,
    isValid: false,
    validationFailures: [
      { isWarning: true, propertyName: "TvCategory", errorMessage: "Category is recommended", severity: "error" },
      { isWarning: false, propertyName: "", errorMessage: "Unable to write to folder", severity: "error" },
    ],
  },
];

// Radarr develop: POST /api/v3/downloadclient/test → 400, the runtime type.
const STJ_SINGLE_TEST_400 = `[
  {
    "isWarning": true,
    "detailedDescription": "Radarr will not attempt to import completed downloads without a category.",
    "propertyName": "MovieCategory",
    "errorMessage": "Category is recommended",
    "severity": "error"
  }
]`;

// ProviderControllerBase's SharedValidator `Name ... .Must(unique).WithMessage("Should be unique")`,
// thrown by RestController.ValidateResource as a plain FluentValidation 9.5.4
// failure — no isWarning; DictionaryKeyPolicy camelCases the placeholder keys.
const RESOURCE_VALIDATION_400 = `[
  {
    "propertyName": "Name",
    "errorMessage": "Should be unique",
    "attemptedValue": "SAB",
    "severity": "error",
    "errorCode": "PredicateValidator",
    "formattedMessagePlaceholderValues": { "propertyName": "Name", "propertyValue": "SAB" }
  }
]`;

test("STJ Test All: a provider whose failures carry no warning flag is uncertain — not failed, not 'working'", () => {
  const results = projectTestAll(JSON.parse(STJ_TEST_ALL));
  assert.deepEqual(results, [
    { id: 1, ok: false, warning: false, messages: ["Category is recommended"], uncertain: true },
    { id: 2, ok: true, warning: false, messages: [] },
  ]);
});

test("STJ Test All: severity \"error\" is FluentValidation's default, never evidence of an error", () => {
  const r = projectTestAll([{ id: 4, isValid: false, validationFailures: [{ propertyName: "", errorMessage: "Unable to connect to indexer", severity: "error" }] }]);
  assert.equal(r[0].uncertain, true);
  assert.equal(r[0].ok, false);
});

test("Sonarr v3 Test All (Newtonsoft) carries isWarning: warnings-only is working with warnings, any error is failed", () => {
  assert.deepEqual(projectTestAll(SONARR_V3_TEST_ALL), [
    { id: 1, ok: true, warning: true, messages: ["Category is recommended"] },
    { id: 2, ok: false, warning: false, messages: ["Unable to connect to SABnzbd"] },
    { id: 3, ok: false, warning: false, messages: ["Category is recommended", "Unable to write to folder"] },
  ]);
});

test("Test All: one known error beside unflagged entries is a failure, and an unreadable entry is an error", () => {
  const [mixed] = projectTestAll([{ id: 5, isValid: false, validationFailures: [{ errorMessage: "maybe", severity: "error" }, { errorMessage: "down", isWarning: false }] }]);
  assert.deepEqual(mixed, { id: 5, ok: false, warning: false, messages: ["maybe", "down"] });
  const [garbage] = projectTestAll([{ id: 6, isValid: false, validationFailures: [{ errorMessage: "maybe" }, "garbage"] }]);
  assert.equal(garbage.uncertain, undefined, "an entry we can't read never softens a failure");
  assert.equal(garbage.ok, false);
  const [warnPlusUnknown] = projectTestAll([{ id: 7, isValid: false, validationFailures: [{ errorMessage: "w", isWarning: true }, { errorMessage: "?" }] }]);
  assert.deepEqual(warnPlusUnknown, { id: 7, ok: false, warning: false, messages: ["w", "?"], uncertain: true }, "a warning plus an unflagged entry is still unclear");
});

test("a single test's 400 always says: isWarning decides, a resource validator's unflagged failure is an error, never uncertain", () => {
  const warned = validationFailuresFromBody(STJ_SINGLE_TEST_400);
  assert.equal(warned.warningsOnly, true);
  assert.deepEqual(testResultOf(1, false, warned), { id: 1, ok: true, warning: true, messages: ["Category is recommended"] });

  const plain = validationFailuresFromBody(RESOURCE_VALIDATION_400);
  assert.equal(plain.warningsOnly, false);
  assert.equal(plain.uncertain, false);
  assert.deepEqual(testResultOf(1, false, plain), { id: 1, ok: false, warning: false, messages: ["Should be unique"] });
  assert.equal(projectFailures(JSON.parse(RESOURCE_VALIDATION_400)).uncertain, false, "the default reading is the 400 body's");
});

test("the Arr System page renders an uncertain row neutrally, before the red failure, and counts it apart in the summary", () => {
  const src = read("src/components/admin/arr-system.tsx");
  const uncertainAt = src.indexOf("if (r.uncertain === true) {");
  const dangerAt = src.indexOf('style={{ color: "var(--ds-danger)" }}>', uncertainAt);
  assert.ok(uncertainAt > 0 && dangerAt > uncertainAt, "the uncertain branch comes before the failure branch");
  const branch = src.slice(uncertainAt, dangerAt);
  assert.match(branch, /style=\{\{ color: "var\(--ds-fg-muted\)" \}\}/);
  assert.match(branch, /t\("adminArr\.system\.testUncertain", \{ service: SERVICE_LABEL\[service\] \}\)/);
  assert.ok(!/text-white|bg-white|#[0-9a-f]{3,6}\b/i.test(branch), "guardrail 42");
  assert.match(src, /uncertain: answered\.filter\(\(r\) => r\.uncertain === true\)\.length/);
  assert.match(src, /t\("adminArr\.system\.testSummaryUncertain", \{ count: s\.uncertain \}\)/);
  assert.match(src, /s\.working \+ s\.uncertain === s\.count \? "text-zinc-400"/);

  for (const locale of ["en", "de", "es", "fr", "it", "pt", "zh"]) {
    const cat = JSON.parse(read(`src/lib/i18n/messages/${locale}/adminArr.json`)) as Record<string, string>;
    assert.match(cat["adminArr.system.testUncertain"] ?? "", /\{service\}/, locale);
    for (const form of ["_one", "_other"]) assert.match(cat[`adminArr.system.testSummaryUncertain${form}`] ?? "", /\{count\}/, `${locale}${form}`);
  }
});
