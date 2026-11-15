// What the custom-format detail view shows of a stored TRaSH payload. Pure, no
// "use client", so the unit suite drives it (tests/trash-spec-detail-view.test.mts).
//
// The payload is TRaSH's own JSON, kept whole (SPEC_DETAIL_ANSWER checks only
// that it is an object), and the refresh validator checks `specifications` only
// for being an array — its elements are deliberately left alone there, because
// the appliers tolerate an odd one. So every value is checked HERE, field by
// field, before it is rendered: a null element or an object where a name
// belongs costs that element or that field, never the page (an object handed
// to React as a child throws during render).
import { check, v, type Schema } from "@/lib/validate";

export interface CustomFormatSpecView {
  name: string;
  implementation: string;
  negate: boolean;
  required: boolean;
  /** The spec's `value` field as text (cut to 60 characters), or null when it has none. */
  value: string | null;
}

export interface CustomFormatDetailView {
  trashId: string;
  includeWhenRenaming: boolean;
  /** Score set → score, finite numbers only. */
  scores: Array<[string, number]>;
  specs: CustomFormatSpecView[];
}

const VALUE_MAX = 60;

function read<T>(schema: Schema<T>, value: unknown): T | undefined {
  const res = check(schema, value);
  return res.ok ? res.value : undefined;
}

const text = (value: unknown): string => read(v.string(), value) ?? "";
const flag = (value: unknown): boolean => read(v.boolean(), value) ?? false;
const record = (value: unknown): Record<string, unknown> | undefined => read(v.record(v.unknown()), value);

// TRaSH keys a spec's fields either as [{ name, value }] or as { value }.
function specValue(fields: unknown): unknown {
  if (Array.isArray(fields)) {
    for (const f of fields) {
      const field = record(f);
      if (field && field.name === "value") return field.value;
    }
    return undefined;
  }
  return record(fields)?.value;
}

function valueText(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value).slice(0, VALUE_MAX);
  }
  // An array or object: its JSON, never "[object Object]".
  try {
    return (JSON.stringify(value) ?? "").slice(0, VALUE_MAX) || null;
  } catch {
    return null;
  }
}

export function customFormatDetailView(payload: unknown): CustomFormatDetailView {
  const root = record(payload) ?? {};
  const scores: Array<[string, number]> = [];
  for (const [set, score] of Object.entries(record(root.trash_scores) ?? {})) {
    if (typeof score === "number" && Number.isFinite(score)) scores.push([set, score]);
  }
  const specs: CustomFormatSpecView[] = [];
  for (const element of Array.isArray(root.specifications) ? root.specifications : []) {
    const spec = record(element);
    if (!spec) continue;
    specs.push({
      name: text(spec.name),
      implementation: text(spec.implementation),
      negate: flag(spec.negate),
      required: flag(spec.required),
      value: valueText(specValue(spec.fields)),
    });
  }
  return {
    trashId: text(root.trash_id),
    includeWhenRenaming: flag(root.includeCustomFormatWhenRenaming),
    scores,
    specs,
  };
}
