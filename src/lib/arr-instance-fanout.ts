// One read per configured Radarr/Sonarr instance, each on its own: a failed
// instance is NAMED (its message and kind), never read as "nothing there"
// (guardrail 32), and — for the pages that re-read on a timer — a failure is
// logged once per unchanged condition and forgotten when it clears
// (guardrail 7b). The admin queue, Missing, Arr System and disk-space loaders
// share it so the rule is written once.
import { arrErrorKind, arrErrorMessage } from "./arr";
import type { ArrErrorKind } from "./arr-error-kind";
import { settleLimit } from "./concurrency";
import { forgetWarnOnChange, warnOnChange } from "./log-dedup";

export type InstanceOutcome<I, T> =
  | { inst: I; ok: true; value: T }
  | { inst: I; ok: false; error: string; kind: ArrErrorKind };

export interface InstanceFailureLog<I> {
  /** The warnOnChange key for this instance's condition. */
  key(inst: I): string;
  /** The line logged when it changes. */
  message(inst: I, error: string): string;
}

/** `read` over every instance (at most `concurrency` at once), each outcome in `instances` order. */
export async function settleArrInstances<I, T>(
  instances: readonly I[],
  concurrency: number,
  read: (inst: I) => Promise<T>,
  log?: InstanceFailureLog<I>,
): Promise<Array<InstanceOutcome<I, T>>> {
  const settled = await settleLimit(instances, concurrency, read);
  return settled.map((s, i): InstanceOutcome<I, T> => {
    const inst = instances[i];
    if (s.status === "fulfilled") {
      if (log) forgetWarnOnChange(log.key(inst));
      return { inst, ok: true, value: s.value };
    }
    const error = arrErrorMessage(s.reason);
    if (log) warnOnChange(log.key(inst), error, log.message(inst, error));
    return { inst, ok: false, error, kind: arrErrorKind(s.reason) };
  });
}
