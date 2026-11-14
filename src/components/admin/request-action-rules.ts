// The request queue row's actions (request-actions.tsx): which controls a
// status gets, what a decision's answer leaves on screen, and the shapes of the
// answers it reads. Pure, no "use client", so the unit suite drives it
// (tests/request-action-rules.test.mts).
import { v } from "@/lib/validate";

export const REQUEST_STATUSES = ["PENDING", "APPROVED", "DECLINED", "AVAILABLE"] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

/** The MediaType enum: Radarr for MOVIE, Sonarr for TV. */
export type RequestMediaType = "MOVIE" | "TV";

/**
 * The status as one the row knows how to act on, or null. The row is handed
 * the stored string; a status it doesn't know (a typo, a status added later)
 * must never fall through to the Approve/Decline buttons.
 */
export function parseRequestStatus(status: string): RequestStatus | null {
  return (REQUEST_STATUSES as readonly string[]).includes(status) ? (status as RequestStatus) : null;
}

/** A single request's PATCH answer: the row, plus what the Radarr/Sonarr push did. */
export const DecisionAnswer = v.object({
  arrError: v.optional(v.nullable(v.string())),
  arrPushOutcomeUnknown: v.optional(v.boolean()),
});

/** Search and Re-push answer the row with `arrError` set when the arr refused. */
export const ArrActionAnswer = v.object({ arrError: v.optional(v.nullable(v.string())) });

/** The approve-with-profile picker's list for one instance. */
export const QualityProfilesAnswer = v.object({
  qualityProfiles: v.array(v.object({ id: v.int(), name: v.string() })),
  defaultId: v.nullable(v.int()),
});

/**
 * What a decision's 200 leaves on screen: the push failure to show, and
 * whether the optimistic status stands.
 *
 * - No push failure: it stands (the refresh confirms it).
 * - A single request whose push FAILED was rolled back to PENDING server-side;
 *   its stored status never changes, so an optimistic APPROVED would mask the
 *   real PENDING row (Approve/Decline hidden, a Re-push the route refuses). It
 *   is dropped. A push that got NO answer leaves the request APPROVED — the
 *   arr may have the title — so it stands.
 * - A group (the batch route) names its definite failures in `failed`; each is
 *   PENDING again, and a group shows its lowest status, so the row is PENDING
 *   for the members left. It is dropped, and the batch route only ever claims
 *   PENDING rows, so a Decline from there never touches the approved members.
 */
export function decisionOutcome(answer: {
  arrError?: string | null;
  /** The single route's `arrPushOutcomeUnknown`; a group's answer has no such flag. */
  pushOutcomeUnknown?: boolean;
}): { arrError: string | null; keepOptimistic: boolean } {
  const arrError = answer.arrError ? answer.arrError : null;
  return { arrError, keepOptimistic: arrError === null || answer.pushOutcomeUnknown === true };
}

/** `arrError` from a refusal's body (Search and Re-push answer one on a 4xx too), else null. */
export function arrErrorOf(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const value = (body as { arrError?: unknown }).arrError;
  return typeof value === "string" && value ? value : null;
}

/** The fields of a group's request that the row's actions are aimed with. */
export interface ActionTarget {
  requestId: string;
  status: string;
  /** "" = the default instance. */
  arrInstance: string;
  adminNote: string | null;
}

/**
 * The requests a title's row can aim its actions at: one per distinct
 * (status, instance) among the group's requests, the representative first.
 *
 * The row shows ONE set of controls. They used to act only on the
 * representative — the first request whose status is the group's aggregate —
 * so a second APPROVED request on another instance (HD and 4K both approved,
 * the 4K push failed) could not be re-pushed or inspected, and a DECLINED one
 * beside an APPROVED one could only be reached through the status filter.
 * Requests that share status AND instance are one target: Why?, Search,
 * Re-push and Pick release act on the title on that instance, whoever asked.
 */
export function actionTargets<T extends ActionTarget>(requesters: readonly T[], aggregateStatus: string): T[] {
  const representative = requesters.find((r) => r.status === aggregateStatus) ?? requesters[0];
  if (!representative) return [];
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of [representative, ...requesters]) {
    const key = `${r.status}|${r.arrInstance}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

/**
 * The target the admin picked, while the group still offers it; otherwise the
 * representative (the first). A pick outlives a list refresh only by its
 * request id — once that request left the group or stopped being a distinct
 * target, the row is back on its default. Undefined only for an empty list.
 */
export function chosenActionTarget<T extends ActionTarget>(targets: readonly T[], chosenId: string | null): T | undefined {
  return targets.find((r) => r.requestId === chosenId) ?? targets[0];
}
