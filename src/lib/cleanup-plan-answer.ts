// What the shared cleanup delete flow (src/components/admin/cleanup-delete.tsx)
// reads from POST /api/admin/cleanup/delete — the dry run's plan, a 409's fresh
// plan, the execute's results — checked here before the confirm panel renders
// or confirms against any of it. Pure apart from validate.ts, so the unit
// suite reads it directly (tests/cleanup-plan-answer.test.mts).
//
// ONE plan parser for the dry run and the 409: the panel confirms "N deletions,
// X GB" against whichever plan is on screen, and a second hand-built copy (the
// 409 used to be cast and its size re-summed in the hook) was where the two
// drifted.
import { check, v, type Infer } from "./validate";
import { cleanupExecuteFailure } from "./cleanup-execute-outcome";

const PlanItemSchema = v.object({
  tmdbId: v.int(),
  mediaType: v.literal("MOVIE", "TV"),
  title: v.string(),
  targets: v.array(v.object({ service: v.string(), instance: v.string(), title: v.string(), sizeOnDisk: v.number() })),
});

const PlanAnswerSchema = v.object({
  targetCount: v.int(),
  // The exact target set (the route's cleanupTargetsFingerprint), echoed by the
  // execute so a same-sized different set is refused. Absent from an older server.
  targetsFingerprint: v.optional(v.string()),
  // Absent from an older server's 409; summed from the targets then.
  reclaimableBytes: v.optional(v.number()),
  items: v.array(PlanItemSchema),
  skipped: v.optional(v.array(v.object({ tmdbId: v.int(), mediaType: v.string(), title: v.nullable(v.string()), reason: v.string() }))),
});

export type CleanupPlan = {
  targetCount: number;
  targetsFingerprint?: string;
  reclaimableBytes: number;
  items: Array<Infer<typeof PlanItemSchema>>;
  skipped: Array<{ tmdbId: number; mediaType: string; title: string | null; reason: string }>;
};

/** A dry run's (or a 409's) plan, or null when the body isn't one. */
export function planFromAnswer(body: unknown): CleanupPlan | null {
  const parsed = check(PlanAnswerSchema, body);
  if (!parsed.ok) return null;
  const { targetCount, targetsFingerprint, reclaimableBytes, items, skipped } = parsed.value;
  return {
    targetCount,
    ...(targetsFingerprint !== undefined ? { targetsFingerprint } : {}),
    // A title that dropped out of the plan drops out of the size the admin
    // confirms against too.
    reclaimableBytes: reclaimableBytes ?? items.reduce((n, it) => n + it.targets.reduce((m, tg) => m + tg.sizeOnDisk, 0), 0),
    items,
    skipped: skipped ?? [],
  };
}

const ExecResultSchema = v.object({
  deletedCount: v.int(),
  partialCount: v.int(),
  failedCount: v.int(),
  results: v.array(v.object({
    tmdbId: v.int(),
    mediaType: v.string(),
    title: v.string(),
    status: v.literal("deleted", "partial", "failed"),
    deleted: v.array(v.string()),
    // `service`/`instance`/`kind` name and word a failure (arrFailureText);
    // `target` + `error` are the English fallback for a response without them.
    failed: v.array(v.object({
      target: v.string(),
      error: v.string(),
      service: v.optional(v.string()),
      instance: v.optional(v.string()),
      kind: v.optional(v.string()),
    })),
    // A delete got no answer (a timeout, a 502/504), so the arr may have taken
    // it anyway — its stamps were kept (guardrail 14b).
    uncertain: v.optional(v.boolean()),
  })),
});

export type CleanupExecResult = Infer<typeof ExecResultSchema>;

/** Marks a body that wasn't JSON (a proxy's page). */
export const NOT_JSON: unique symbol = Symbol("not json");

// What the execute's answer means for the plan on screen:
//   done     — the results; the plan is spent.
//   conflict — the 409: something changed since the dry run; its fresh plan
//              (null when unreadable) replaces the old one, unconfirmed.
//   refused  — the route's own refusal, answered before any delete: the plan stands.
//   unknown  — no answer from the ROUTE (a gateway, a page that isn't its JSON,
//              a 2xx that isn't its results): some titles may already be gone,
//              so the plan is dropped (cleanupExecuteFailure).
export type ExecuteAnswer =
  | { kind: "done"; result: CleanupExecResult }
  | { kind: "conflict"; plan: CleanupPlan | null }
  | { kind: "refused"; error: string }
  | { kind: "unknown"; messageKey: "adminManage.cleanup.error.deleteUnknown" | "adminManage.cleanup.error.deleteNetwork" };

export function readExecuteAnswer(status: number, body: unknown): ExecuteAnswer {
  const json = body === NOT_JSON ? null : body;
  if (status === 409) return { kind: "conflict", plan: planFromAnswer(json) };
  if (status < 200 || status > 299) {
    const failure = cleanupExecuteFailure(status, json);
    return failure.kind === "refused"
      ? { kind: "refused", error: failure.error }
      : { kind: "unknown", messageKey: "adminManage.cleanup.error.deleteUnknown" };
  }
  const result = check(ExecResultSchema, json);
  return result.ok
    ? { kind: "done", result: result.value }
    : { kind: "unknown", messageKey: "adminManage.cleanup.error.deleteNetwork" };
}
