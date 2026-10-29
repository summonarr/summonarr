// Where did a failed transaction's time go, and why did it fail?
//
// A Prisma P2028 ("expired transaction") names the operation that STARTED after
// the deadline, not the slow one before it, and Prisma's own error log repeats
// that. A step trace plus a classified cause puts the real answer in one line.
import { txFailureKind, type TxFailureKind } from "./prisma-errors";

export interface TxTrace {
  /** Starts a named step; the previous step ends here. */
  step(name: string): void;
  /** Total time since the trace was created. */
  elapsedMs(): number;
  /** "delete old edges 0.1s, insert 2000 edges 24.9s" — the last step runs to now. */
  summary(): string;
}

export function txTrace(now: () => number = Date.now): TxTrace {
  const start = now();
  const steps: { name: string; at: number }[] = [];
  return {
    step(name) {
      steps.push({ name, at: now() });
    },
    elapsedMs() {
      return now() - start;
    },
    summary() {
      const end = now();
      return steps.map((s, i) => `${s.name} ${seconds((steps[i + 1]?.at ?? end) - s.at)}`).join(", ");
    },
  };
}

export interface TxLimits {
  txTimeoutMs: number;
  statementTimeoutMs?: number;
  lockTimeoutMs?: number;
}

export function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

// A plain-language cause. Only "other" falls back to the error's own message
// (its last line, which for a Prisma error is the database's answer rather than
// the "Invalid `prisma.x()` invocation:" header).
export function describeTxFailure(err: unknown, limits: TxLimits): { kind: TxFailureKind; text: string } {
  const kind = txFailureKind(err);
  const limit = (ms: number | undefined) => (ms === undefined ? "" : ` ${seconds(ms)}`);
  switch (kind) {
    case "lock-timeout":
      return { kind, text: `waited past the${limit(limits.lockTimeoutMs)} lock timeout for rows another transaction holds` };
    case "statement-timeout":
      return { kind, text: `a statement ran past the${limit(limits.statementTimeoutMs)} statement timeout and Postgres cancelled it` };
    case "cancelled":
      return { kind, text: "Postgres cancelled a statement (not one of this transaction's timeouts)" };
    case "deadlock":
      return { kind, text: "deadlocked with another transaction, and Postgres aborted this one" };
    case "serialization":
      return { kind, text: "conflicted with a concurrent transaction (serialization failure)" };
    case "expired":
      return { kind, text: `ran past the ${seconds(limits.txTimeoutMs)} transaction limit` };
    case "start-timeout":
      return { kind, text: "got no database connection in time (the pool was busy)" };
    default:
      return { kind, text: lastLine(err) };
  }
}

function lastLine(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const lines = message.split("\n").map((l) => l.trim()).filter(Boolean);
  const line = lines.at(-1) ?? "unknown error";
  return line.length > 300 ? `${line.slice(0, 300)}…` : line;
}
