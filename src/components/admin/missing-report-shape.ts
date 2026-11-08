// The shape Admin → Missing reads from GET /api/admin/missing — the live read
// and its snapshot alike (use-missing-reports.ts). Pure and directive-free
// (tests/missing-report-shape.test.mts).
//
// The envelope is checked whole: a 200 that is an error, or another shape,
// never lands in the list as a report. Each row's identity is checked too —
// its instance and arr id key the selection, the searches and "Retry failed",
// its title labels it — and the row is then handed on WHOLE: its display
// fields are the route's own projection (src/lib/arr-missing.ts), and v.object
// would drop every field it doesn't name.
import { ARR_ERROR_KIND_KEYS, type ArrErrorKind } from "@/lib/arr-error-kind";
import { v, type Infer, type Schema } from "@/lib/validate";

/** What every listed row carries, whatever the list. */
export interface ListedRow {
  instance: string;
  arrId: number;
  title: string;
}

function isListedRow(x: unknown): x is ListedRow {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return false;
  const r = x as Record<string, unknown>;
  return typeof r.instance === "string" && Number.isSafeInteger(r.arrId) && typeof r.title === "string";
}

const LISTED_ROW: Schema<ListedRow> = {
  expected: "a row with instance, arrId and title",
  run: (value) =>
    isListedRow(value)
      ? { ok: true, value }
      : { ok: false, path: [], message: "expected a row with instance, arrId and title" },
};

// The keys of ARR_ERROR_KIND_KEYS are exactly ArrErrorKind (its `satisfies`).
const ARR_ERROR_KINDS = Object.keys(ARR_ERROR_KIND_KEYS) as ArrErrorKind[];

export const MISSING_REPORT = v.object({
  service: v.literal("sonarr", "radarr"),
  enabled: v.boolean(),
  instances: v.array(v.object({ slug: v.string(), name: v.string() })),
  errors: v.array(v.object({ instance: v.string(), error: v.string(), kind: v.optional(v.literal(...ARR_ERROR_KINDS)) })),
  items: v.array(LISTED_ROW),
  truncated: v.optional(v.array(v.object({ instance: v.string(), read: v.number(), total: v.number() }))),
});
export type CheckedMissingReport = Infer<typeof MISSING_REPORT>;
