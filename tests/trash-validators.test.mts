// Unit tests for the TRaSH-Guides payload type guards (src/lib/trash-validators.ts).
// These run in refreshCatalog immediately after JSON.parse of upstream JSON; a false
// return skips the upsert (preserving the prior good upstreamSha) and increments the
// validationSkipped diagnostic — so the accept/reject boundary IS the safety contract
// between arbitrary upstream bytes and the Arr apply path. The appliers run them again
// on the stored payload. Pins: required-vs-optional
// fields per payload kind, the "optional but must be array/object when present" rules
// that keep the apply loops from throwing on non-iterables, and the boolean (never
// throwing) contract for every malformed shape.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isCustomFormatPayload,
  isCustomFormatGroupPayload,
  isQualityProfilePayload,
  isQualitySizePayload,
  isNamingPayload,
} from "../src/lib/trash-validators.ts";

// Non-object junk every guard must reject without throwing. All of these are
// reachable in practice: upstream JSON.parse can yield any of them at the top level.
const NON_OBJECTS: unknown[] = [null, undefined, "trash_id", 42, true, false, [], ["x"]];

// isCustomFormatPayload

test("custom format: minimal {trash_id, name} is accepted", () => {
  assert.equal(isCustomFormatPayload({ trash_id: "cf1", name: "x265" }), true);
});

test("custom format: unknown upstream fields pass through untouched", () => {
  // The guard deliberately checks only fields the apply path consumes.
  assert.equal(
    isCustomFormatPayload({
      trash_id: "cf1",
      name: "x265",
      trash_scores: { default: 100 },
      includeCustomFormatWhenRenaming: false,
      some_future_field: { nested: true },
    }),
    true,
  );
});

test("custom format: non-object payloads are rejected", () => {
  for (const v of NON_OBJECTS) {
    assert.equal(isCustomFormatPayload(v), false, `expected reject for ${JSON.stringify(v)}`);
  }
});

test("custom format: missing/empty/non-string trash_id or name is rejected", () => {
  assert.equal(isCustomFormatPayload({ name: "x265" }), false);
  assert.equal(isCustomFormatPayload({ trash_id: "", name: "x265" }), false);
  assert.equal(isCustomFormatPayload({ trash_id: 7, name: "x265" }), false);
  assert.equal(isCustomFormatPayload({ trash_id: "cf1" }), false);
  assert.equal(isCustomFormatPayload({ trash_id: "cf1", name: "" }), false);
  assert.equal(isCustomFormatPayload({ trash_id: "cf1", name: null }), false);
});

test("custom format: specifications is optional but must be an array when present", () => {
  // undefined → skip the check entirely
  assert.equal(isCustomFormatPayload({ trash_id: "cf1", name: "n", specifications: undefined }), true);
  // array (even empty) → ok; contents are deliberately unvalidated here
  assert.equal(isCustomFormatPayload({ trash_id: "cf1", name: "n", specifications: [] }), true);
  assert.equal(isCustomFormatPayload({ trash_id: "cf1", name: "n", specifications: ["loose", 1] }), true);
  // plain object / null / string break the apply-time iteration → rejected
  assert.equal(isCustomFormatPayload({ trash_id: "cf1", name: "n", specifications: {} }), false);
  assert.equal(isCustomFormatPayload({ trash_id: "cf1", name: "n", specifications: null }), false);
  assert.equal(isCustomFormatPayload({ trash_id: "cf1", name: "n", specifications: "[]" }), false);
});

// isCustomFormatGroupPayload

test("group: {trash_id, name, custom_formats: []} is accepted (empty membership ok)", () => {
  assert.equal(
    isCustomFormatGroupPayload({ trash_id: "g1", name: "HDR Formats", custom_formats: [] }),
    true,
  );
});

test("group: members need only trash_id; name and required are optional, extra fields ignored", () => {
  assert.equal(
    isCustomFormatGroupPayload({
      trash_id: "g1",
      name: "HDR Formats",
      custom_formats: [
        { trash_id: "cf1", name: "DV", required: true },
        { trash_id: "cf2" }, // name and required may be absent: not required, named by trash_id
      ],
      quality_profiles: { include: { "SQP-1": "..." } },
    }),
    true,
  );
});

test("group: custom_formats is REQUIRED and must be an array", () => {
  // Unlike custom-format specifications, a missing array is rejected: a non-array
  // shape would silently resolve to zero members and mark every group apply as ok.
  assert.equal(isCustomFormatGroupPayload({ trash_id: "g1", name: "n" }), false);
  assert.equal(isCustomFormatGroupPayload({ trash_id: "g1", name: "n", custom_formats: {} }), false);
  assert.equal(isCustomFormatGroupPayload({ trash_id: "g1", name: "n", custom_formats: null }), false);
});

test("group: any malformed member rejects the whole payload", () => {
  const base = { trash_id: "g1", name: "n" };
  assert.equal(isCustomFormatGroupPayload({ ...base, custom_formats: ["cf1"] }), false);
  assert.equal(isCustomFormatGroupPayload({ ...base, custom_formats: [null] }), false);
  assert.equal(isCustomFormatGroupPayload({ ...base, custom_formats: [{ name: "no id" }] }), false);
  assert.equal(isCustomFormatGroupPayload({ ...base, custom_formats: [{ trash_id: "" }] }), false);
  // One good member does not rescue a bad sibling.
  assert.equal(
    isCustomFormatGroupPayload({ ...base, custom_formats: [{ trash_id: "ok" }, { trash_id: 5 }] }),
    false,
  );
});

test("group: non-object payloads and missing id/name are rejected", () => {
  for (const v of NON_OBJECTS) {
    assert.equal(isCustomFormatGroupPayload(v), false, `expected reject for ${JSON.stringify(v)}`);
  }
  assert.equal(isCustomFormatGroupPayload({ name: "n", custom_formats: [] }), false);
  assert.equal(isCustomFormatGroupPayload({ trash_id: "g1", name: "", custom_formats: [] }), false);
});

// isQualityProfilePayload

test("quality profile: minimal {trash_id, name} is accepted (items/formatItems optional)", () => {
  assert.equal(isQualityProfilePayload({ trash_id: "qp1", name: "SQP-1" }), true);
});

test("quality profile: full upstream shape is accepted", () => {
  assert.equal(
    isQualityProfilePayload({
      trash_id: "qp1",
      name: "SQP-1",
      upgradeAllowed: true,
      cutoff: "Bluray-1080p",
      cutoffFormatScore: 10000,
      minFormatScore: 0,
      items: [{ name: "Bluray-1080p", allowed: true }, { name: "WEB 1080p", allowed: true, items: ["WEBDL-1080p"] }],
      formatItems: { "DV HDR10": "required" },
    }),
    true,
  );
});

test("quality profile: items must be an array when present", () => {
  assert.equal(isQualityProfilePayload({ trash_id: "qp1", name: "n", items: [] }), true);
  assert.equal(isQualityProfilePayload({ trash_id: "qp1", name: "n", items: {} }), false);
  assert.equal(isQualityProfilePayload({ trash_id: "qp1", name: "n", items: null }), false);
  assert.equal(isQualityProfilePayload({ trash_id: "qp1", name: "n", items: "Bluray" }), false);
});

test("quality profile: formatItems must be a plain object when present (arrays rejected)", () => {
  assert.equal(isQualityProfilePayload({ trash_id: "qp1", name: "n", formatItems: {} }), true);
  // isObject excludes arrays — a formatItems array is NOT the Record shape buildProfileBody reads.
  assert.equal(isQualityProfilePayload({ trash_id: "qp1", name: "n", formatItems: [] }), false);
  assert.equal(isQualityProfilePayload({ trash_id: "qp1", name: "n", formatItems: null }), false);
  assert.equal(isQualityProfilePayload({ trash_id: "qp1", name: "n", formatItems: "x" }), false);
});

test("quality profile: every items entry needs a name, a boolean allowed, and string members", () => {
  const base = { trash_id: "qp1", name: "n" };
  // A TRaSH-shaped list (standalone qualities and a group) is accepted.
  assert.equal(
    isQualityProfilePayload({
      ...base,
      items: [
        { name: "Remux 1080p", allowed: true, items: ["Remux-1080p", "Bluray-1080p"] },
        { name: "DVD", allowed: false },
      ],
    }),
    true,
  );
  assert.equal(isQualityProfilePayload({ ...base, items: [null] }), false);
  assert.equal(isQualityProfilePayload({ ...base, items: ["Bluray-1080p"] }), false);
  assert.equal(isQualityProfilePayload({ ...base, items: [{ allowed: true }] }), false);
  assert.equal(isQualityProfilePayload({ ...base, items: [{ name: "", allowed: true }] }), false);
  assert.equal(isQualityProfilePayload({ ...base, items: [{ name: "DVD" }] }), false);
  assert.equal(isQualityProfilePayload({ ...base, items: [{ name: "DVD", allowed: "true" }] }), false);
  assert.equal(isQualityProfilePayload({ ...base, items: [{ name: "G", allowed: true, items: "WEBDL-1080p" }] }), false);
  assert.equal(isQualityProfilePayload({ ...base, items: [{ name: "G", allowed: true, items: ["WEBDL-1080p", 3] }] }), false);
  assert.equal(isQualityProfilePayload({ ...base, items: [{ name: "G", allowed: true, items: [""] }] }), false);
});

test("quality profile: every formatItems value must be a non-empty trash_id string", () => {
  const base = { trash_id: "qp1", name: "n" };
  assert.equal(isQualityProfilePayload({ ...base, formatItems: { DV: "cf-dv", HDR: "cf-hdr" } }), true);
  assert.equal(isQualityProfilePayload({ ...base, formatItems: { DV: 7 } }), false);
  assert.equal(isQualityProfilePayload({ ...base, formatItems: { DV: "" } }), false);
  assert.equal(isQualityProfilePayload({ ...base, formatItems: { DV: null } }), false);
  assert.equal(isQualityProfilePayload({ ...base, formatItems: { DV: ["cf-dv"] } }), false);
});

test("custom format: trash_scores must be an object of finite numbers when present", () => {
  const base = { trash_id: "cf1", name: "n" };
  assert.equal(isCustomFormatPayload({ ...base, trash_scores: { default: -10000, "sqp-1": 0 } }), true);
  assert.equal(isCustomFormatPayload({ ...base, trash_scores: [] }), false);
  assert.equal(isCustomFormatPayload({ ...base, trash_scores: null }), false);
  assert.equal(isCustomFormatPayload({ ...base, trash_scores: { default: "100" } }), false);
  assert.equal(isCustomFormatPayload({ ...base, trash_scores: { default: Infinity } }), false);
});

test("quality profile: non-object payloads and missing id/name are rejected", () => {
  for (const v of NON_OBJECTS) {
    assert.equal(isQualityProfilePayload(v), false, `expected reject for ${JSON.stringify(v)}`);
  }
  assert.equal(isQualityProfilePayload({ trash_id: "qp1" }), false);
  assert.equal(isQualityProfilePayload({ name: "SQP-1" }), false);
  assert.equal(isQualityProfilePayload({ trash_id: "qp1", name: "" }), false);
});

// isQualitySizePayload

test("quality size: {trash_id, qualities: []} is accepted — name is NOT required here", () => {
  // Unlike the other payload kinds, quality-size upstream JSON has no name field to require.
  assert.equal(isQualitySizePayload({ trash_id: "qs1", qualities: [] }), true);
});

test("quality size: entries need quality + numeric min/max; preferred is optional", () => {
  assert.equal(
    isQualitySizePayload({
      trash_id: "qs1",
      type: "movie",
      qualities: [
        { quality: "Bluray-1080p", min: 50.4, max: 227.6, preferred: 194.7 },
        { quality: "HDTV-720p", min: 0, max: 100 }, // zero min + no preferred both fine
      ],
    }),
    true,
  );
});

test("quality size: malformed entries are rejected", () => {
  const base = { trash_id: "qs1" };
  assert.equal(isQualitySizePayload({ ...base, qualities: [null] }), false);
  assert.equal(isQualitySizePayload({ ...base, qualities: ["Bluray-1080p"] }), false);
  assert.equal(isQualitySizePayload({ ...base, qualities: [{ quality: "", min: 0, max: 1 }] }), false);
  assert.equal(isQualitySizePayload({ ...base, qualities: [{ min: 0, max: 1 }] }), false);
  assert.equal(isQualitySizePayload({ ...base, qualities: [{ quality: "q", min: "0", max: 1 }] }), false);
  assert.equal(isQualitySizePayload({ ...base, qualities: [{ quality: "q", min: 0 }] }), false);
  assert.equal(isQualitySizePayload({ ...base, qualities: [{ quality: "q", min: 0, max: null }] }), false);
  // One bad entry rejects the payload even with good siblings.
  assert.equal(
    isQualitySizePayload({
      ...base,
      qualities: [{ quality: "ok", min: 0, max: 1 }, { quality: "bad", min: 0 }],
    }),
    false,
  );
});

test("quality size: qualities is REQUIRED and must be an array", () => {
  assert.equal(isQualitySizePayload({ trash_id: "qs1" }), false);
  assert.equal(isQualitySizePayload({ trash_id: "qs1", qualities: {} }), false);
  assert.equal(isQualitySizePayload({ trash_id: "qs1", qualities: null }), false);
});

test("quality size: non-object payloads and missing trash_id are rejected", () => {
  for (const v of NON_OBJECTS) {
    assert.equal(isQualitySizePayload(v), false, `expected reject for ${JSON.stringify(v)}`);
  }
  assert.equal(isQualitySizePayload({ qualities: [] }), false);
  assert.equal(isQualitySizePayload({ trash_id: "", qualities: [] }), false);
});

test("quality size: min, max and preferred must be finite — JSON's 1e999 parses to Infinity", () => {
  const base = { trash_id: "qs1" };
  const overflow = JSON.parse('{"quality":"q","min":0,"max":1e999}') as unknown;
  assert.equal(isQualitySizePayload({ ...base, qualities: [overflow] }), false);
  assert.equal(isQualitySizePayload({ ...base, qualities: [{ quality: "q", min: NaN, max: 1 }] }), false);
  assert.equal(isQualitySizePayload({ ...base, qualities: [{ quality: "q", min: 0, max: Infinity }] }), false);
  assert.equal(isQualitySizePayload({ ...base, qualities: [{ quality: "q", min: 0, max: 1, preferred: -Infinity }] }), false);
  // preferred is sent as preferredSize when present, so a non-number is refused.
  assert.equal(isQualitySizePayload({ ...base, qualities: [{ quality: "q", min: 0, max: 1, preferred: "5" }] }), false);
  assert.equal(isQualitySizePayload({ ...base, qualities: [{ quality: "q", min: 0, max: 1, preferred: null }] }), false);
  assert.equal(isQualitySizePayload({ ...base, qualities: [{ quality: "q", min: 0, max: 1, preferred: 0.5 }] }), true);
});

test("quality size: `type` names the spec, so it must be a string when present", () => {
  assert.equal(isQualitySizePayload({ trash_id: "qs1", type: "movie", qualities: [] }), true);
  assert.equal(isQualitySizePayload({ trash_id: "qs1", type: null, qualities: [] }), true);
  assert.equal(isQualitySizePayload({ trash_id: "qs1", type: 7, qualities: [] }), false);
  assert.equal(isQualitySizePayload({ trash_id: "qs1", type: { name: "movie" }, qualities: [] }), false);
});

test("group: a member's required flag and name must be a boolean and a string when present", () => {
  const base = { trash_id: "g1", name: "n" };
  assert.equal(isCustomFormatGroupPayload({ ...base, custom_formats: [{ trash_id: "cf1", required: false, name: "DV" }] }), true);
  assert.equal(isCustomFormatGroupPayload({ ...base, custom_formats: [{ trash_id: "cf1", required: "true" }] }), false);
  assert.equal(isCustomFormatGroupPayload({ ...base, custom_formats: [{ trash_id: "cf1", required: 1 }] }), false);
  assert.equal(isCustomFormatGroupPayload({ ...base, custom_formats: [{ trash_id: "cf1", name: 5 }] }), false);
  // The description lands in a string column.
  assert.equal(isCustomFormatGroupPayload({ ...base, trash_description: "HDR", custom_formats: [] }), true);
  assert.equal(isCustomFormatGroupPayload({ ...base, trash_description: ["HDR"], custom_formats: [] }), false);
});

test("quality profile: the scores and settings sent to the arr must have their own types", () => {
  const base = { trash_id: "qp1", name: "n" };
  for (const key of ["minFormatScore", "cutoffFormatScore", "minUpgradeFormatScore"]) {
    assert.equal(isQualityProfilePayload({ ...base, [key]: 100 }), true, key);
    assert.equal(isQualityProfilePayload({ ...base, [key]: null }), true, `${key}: null reads as absent`);
    assert.equal(isQualityProfilePayload({ ...base, [key]: "100" }), false, key);
    assert.equal(isQualityProfilePayload({ ...base, [key]: Infinity }), false, key);
  }
  for (const key of ["cutoff", "language", "score_set", "trash_description"]) {
    assert.equal(isQualityProfilePayload({ ...base, [key]: "x" }), true, key);
    assert.equal(isQualityProfilePayload({ ...base, [key]: 3 }), false, key);
  }
  assert.equal(isQualityProfilePayload({ ...base, upgradeAllowed: false }), true);
  assert.equal(isQualityProfilePayload({ ...base, upgradeAllowed: "yes" }), false);
});

test("custom format: includeCustomFormatWhenRenaming must be a boolean when present", () => {
  const base = { trash_id: "cf1", name: "n" };
  assert.equal(isCustomFormatPayload({ ...base, includeCustomFormatWhenRenaming: true }), true);
  assert.equal(isCustomFormatPayload({ ...base, includeCustomFormatWhenRenaming: null }), true);
  assert.equal(isCustomFormatPayload({ ...base, includeCustomFormatWhenRenaming: "false" }), false);
});

// isNamingPayload

test("naming: any plain object is accepted (per-key validation lives in buildNamingPatch)", () => {
  assert.equal(isNamingPayload({}), true);
  assert.equal(isNamingPayload({ standardMovieFormat: "{Movie Title} ({Release Year})" }), true);
});

test("naming: non-objects and arrays are rejected", () => {
  for (const v of NON_OBJECTS) {
    assert.equal(isNamingPayload(v), false, `expected reject for ${JSON.stringify(v)}`);
  }
});
