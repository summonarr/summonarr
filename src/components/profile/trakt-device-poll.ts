// How the Trakt connect flow (trakt-connect.tsx) reads the server's answers.
// Pure and React-free so the unit suite runs it directly
// (tests/trakt-connect-ui.test.mts); the timer that drives the polls is
// use-trakt-device-poll.ts.
import { apiErrorText } from "@/lib/client/api-error";

// The longest wait between polls while the server keeps failing. The server
// paces the real Trakt calls itself (poll/route.ts), so polling at the base
// interval is cheap; an uncapped doubling could carry the next poll past the
// code's lifetime after the user had already approved it.
export const MAX_POLL_BACKOFF_SECONDS = 60;

// The fallbacks when the start answer omits them. The route caps expiresIn at
// 30 minutes; 10 is Trakt's usual answer.
export const DEFAULT_POLL_INTERVAL_SECONDS = 5;
export const DEFAULT_CODE_LIFETIME_SECONDS = 600;

export interface DeviceCode {
  userCode: string;
  verificationUrl: string;
  interval: number;
  expiresIn: number;
}

function record(data: unknown): Record<string, unknown> {
  return data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
}

function positive(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** The start answer's device code, or null when it carries none. */
export function readDeviceCode(data: unknown): DeviceCode | null {
  const d = record(data);
  if (typeof d.userCode !== "string" || typeof d.verificationUrl !== "string") return null;
  return {
    userCode: d.userCode,
    verificationUrl: d.verificationUrl,
    interval: positive(d.interval, DEFAULT_POLL_INTERVAL_SECONDS),
    expiresIn: positive(d.expiresIn, DEFAULT_CODE_LIFETIME_SECONDS),
  };
}

/** The wait before the next try after a transient failure: doubled, capped. */
export function backoffSeconds(intervalSeconds: number): number {
  return Math.min(intervalSeconds * 2, MAX_POLL_BACKOFF_SECONDS);
}

export type PollStep =
  // Transient (Trakt unreachable, rate limited, no answer): keep waiting, backing off.
  | { kind: "backoff" }
  // An answer: back to the server's own pace.
  | { kind: "pending" }
  | { kind: "connected"; username: string | null }
  | { kind: "denied" }
  | { kind: "conflict" }
  | { kind: "expired" }
  // The route refused; `error` is its own reason, "" when it gave none.
  | { kind: "failed"; error: string };

/** What one poll answer means. `status` 0 is "no answer" (the fetch threw). */
export function readPollAnswer(status: number, data: unknown): PollStep {
  if (status === 0 || status === 429 || status >= 500) return { kind: "backoff" };
  if (status < 200 || status > 299) return { kind: "failed", error: apiErrorText(data, "") };
  const d = record(data);
  switch (d.state) {
    case "pending":
      return { kind: "pending" };
    case "connected":
      return { kind: "connected", username: typeof d.username === "string" ? d.username : null };
    case "denied":
      return { kind: "denied" };
    case "conflict":
      return { kind: "conflict" };
    default:
      return { kind: "expired" };
  }
}
