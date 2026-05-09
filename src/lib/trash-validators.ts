// Hand-rolled type guards for upstream TRaSH-Guides JSON payloads.
//
// These run during refreshCatalog after JSON.parse — malformed payloads are skipped (not upserted)
// so the prior good upstreamSha is preserved. Validation deliberately checks only the fields the
// apply path consumes; new upstream fields pass through untouched (we keep the entire payload as a
// JSON column anyway).
//
// Returning false here surfaces in two places:
//   1. The refresh-result errors[] accumulator — visible in the UI banner and audit log
//   2. The diagnostic endpoint's validationSkipped counter
//
// Hand-rolled rather than zod because the codebase has no other zod usage; adopting it for one
// feature would set a precedent that drifts.

import type {
  TrashCustomFormat,
  TrashCustomFormatGroup,
  TrashQualityProfile,
  TrashQualitySize,
} from "./trash";

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

export function isCustomFormatPayload(v: unknown): v is TrashCustomFormat {
  if (!isObject(v)) return false;
  if (!nonEmptyString(v.trash_id)) return false;
  if (!nonEmptyString(v.name)) return false;
  // specifications drives normalizeSpecFields → Arr POST body. Optional in the upstream schema but,
  // when present, must be array-shaped — plain objects break the apply-time iteration.
  if (v.specifications !== undefined && !Array.isArray(v.specifications)) return false;
  return true;
}

export function isCustomFormatGroupPayload(v: unknown): v is TrashCustomFormatGroup {
  if (!isObject(v)) return false;
  if (!nonEmptyString(v.trash_id)) return false;
  if (!nonEmptyString(v.name)) return false;
  // applyCustomFormatGroups iterates payload.custom_formats[].trash_id — non-array shape silently
  // resolves to zero members today, which would mark every group apply as ok with no work done.
  if (!Array.isArray(v.custom_formats)) return false;
  for (const m of v.custom_formats) {
    if (!isObject(m)) return false;
    if (!nonEmptyString(m.trash_id)) return false;
  }
  return true;
}

export function isQualityProfilePayload(v: unknown): v is TrashQualityProfile {
  if (!isObject(v)) return false;
  if (!nonEmptyString(v.trash_id)) return false;
  if (!nonEmptyString(v.name)) return false;
  // buildProfileBody reads items[] and formatItems{} — both optional but must be array/object
  // when present so the apply loop doesn't throw on a non-iterable.
  if (v.items !== undefined && !Array.isArray(v.items)) return false;
  if (v.formatItems !== undefined && !isObject(v.formatItems)) return false;
  return true;
}

export function isQualitySizePayload(v: unknown): v is TrashQualitySize {
  if (!isObject(v)) return false;
  if (!nonEmptyString(v.trash_id)) return false;
  if (!Array.isArray(v.qualities)) return false;
  for (const q of v.qualities) {
    if (!isObject(q)) return false;
    if (!nonEmptyString(q.quality)) return false;
    if (typeof q.min !== "number" || typeof q.max !== "number") return false;
  }
  return true;
}

// Naming payloads are loose key/value patterns — applyNaming merges them into the existing config.
// We just require an object shape here; per-key validation lives in buildNamingPatch.
export function isNamingPayload(v: unknown): v is Record<string, unknown> {
  return isObject(v);
}
