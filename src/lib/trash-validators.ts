// Hand-rolled type guards for upstream TRaSH-Guides JSON payloads.
//
// They run twice: in refreshCatalog right after JSON.parse (a malformed payload
// is skipped, not upserted, so the prior good upstreamSha is kept and the next
// refresh retries it) and again when an applier reads TrashSpec.payload back,
// because a row written by an older version never passed today's checks.
// Validation checks every field the refresh or an applier reads, and only
// those; new upstream fields pass through untouched (the whole payload is kept
// as a JSON column). An optional field may be absent or null wherever the
// reader treats null as absent.
//
// Returning false here surfaces in two places:
//   1. The refresh-result errors[] accumulator — visible in the UI banner and audit log
//   2. The diagnostic endpoint's validationSkipped counter
//
// Guards rather than validate.ts schemas: a schema check returns a copy with
// only the declared keys, and the refresh stores the payload whole.

import type {
  TrashCustomFormat,
  TrashCustomFormatGroup,
  TrashQualityProfile,
  TrashQualitySize,
} from "./trash-types";

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

// JSON has no NaN, but `1e999` parses to Infinity.
function finiteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isBoolean(v: unknown): v is boolean {
  return typeof v === "boolean";
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}

// Absent, null, or passing `test`: for fields every reader defaults with `??`.
function optional(v: unknown, test: (x: unknown) => boolean): boolean {
  return v === undefined || v === null || test(v);
}

export function isCustomFormatPayload(v: unknown): v is TrashCustomFormat {
  if (!isObject(v)) return false;
  if (!nonEmptyString(v.trash_id)) return false;
  if (!nonEmptyString(v.name)) return false;
  // specifications drives normalizeSpecFields → Arr POST body. Optional in the upstream schema but,
  // when present, must be array-shaped — plain objects break the apply-time iteration.
  if (v.specifications !== undefined && !Array.isArray(v.specifications)) return false;
  if (!optional(v.includeCustomFormatWhenRenaming, isBoolean)) return false;
  // trash_scores becomes each profile's formatItems score, sent to the arr as a number.
  if (v.trash_scores !== undefined) {
    if (!isObject(v.trash_scores)) return false;
    for (const score of Object.values(v.trash_scores)) {
      if (!finiteNumber(score)) return false;
    }
  }
  return true;
}

export function isCustomFormatGroupPayload(v: unknown): v is TrashCustomFormatGroup {
  if (!isObject(v)) return false;
  if (!nonEmptyString(v.trash_id)) return false;
  if (!nonEmptyString(v.name)) return false;
  // Stored in the TrashSpec.description column, which takes a string or null.
  if (!optional(v.trash_description, isString)) return false;
  // applyCustomFormatGroups iterates payload.custom_formats[].trash_id — non-array shape silently
  // resolves to zero members today, which would mark every group apply as ok with no work done.
  if (!Array.isArray(v.custom_formats)) return false;
  for (const m of v.custom_formats) {
    if (!isObject(m)) return false;
    if (!nonEmptyString(m.trash_id)) return false;
    // `required` decides the group's rollup and `name` names a failed member.
    if (!optional(m.required, isBoolean)) return false;
    if (!optional(m.name, isString)) return false;
  }
  return true;
}

export function isQualityProfilePayload(v: unknown): v is TrashQualityProfile {
  if (!isObject(v)) return false;
  if (!nonEmptyString(v.trash_id)) return false;
  if (!nonEmptyString(v.name)) return false;
  // The scalar fields buildProfileBody sends to the arr or reads to build the body.
  if (!optional(v.upgradeAllowed, isBoolean)) return false;
  for (const key of ["minFormatScore", "cutoffFormatScore", "minUpgradeFormatScore"] as const) {
    if (!optional(v[key], finiteNumber)) return false;
  }
  for (const key of ["cutoff", "language", "score_set", "trash_description"] as const) {
    if (!optional(v[key], isString)) return false;
  }
  // buildProfileBody reads items[] and formatItems{} — both optional but must be array/object
  // when present so the apply loop doesn't throw on a non-iterable.
  if (v.items !== undefined) {
    if (!Array.isArray(v.items)) return false;
    // Each entry is a quality or a group of them: buildProfileBody reads name,
    // allowed and the member names.
    for (const item of v.items) {
      if (!isObject(item)) return false;
      if (!nonEmptyString(item.name)) return false;
      if (typeof item.allowed !== "boolean") return false;
      if (item.items !== undefined && (!Array.isArray(item.items) || !item.items.every(nonEmptyString))) {
        return false;
      }
    }
  }
  if (v.formatItems !== undefined) {
    if (!isObject(v.formatItems)) return false;
    // CF name → trash_id. The trash_ids feed a Prisma `in` filter, which
    // rejects anything that isn't a string.
    if (!Object.values(v.formatItems).every(nonEmptyString)) return false;
  }
  return true;
}

export function isQualitySizePayload(v: unknown): v is TrashQualitySize {
  if (!isObject(v)) return false;
  if (!nonEmptyString(v.trash_id)) return false;
  // `type` names the spec (TrashSpec.name, a string column); the file name stands in when absent.
  if (!optional(v.type, isString)) return false;
  if (!Array.isArray(v.qualities)) return false;
  for (const q of v.qualities) {
    if (!isObject(q)) return false;
    if (!nonEmptyString(q.quality)) return false;
    if (!finiteNumber(q.min) || !finiteNumber(q.max)) return false;
    // Sent as preferredSize when present; null would be sent as null, so only absence is optional.
    if (q.preferred !== undefined && !finiteNumber(q.preferred)) return false;
  }
  return true;
}

// Naming payloads are loose key/value patterns — applyNaming merges them into the existing config.
// We just require an object shape here; per-key validation lives in buildNamingPatch.
export function isNamingPayload(v: unknown): v is Record<string, unknown> {
  return isObject(v);
}
