// Client half of the step-up gate (src/lib/step-up-auth.ts, guardrail 6g).
// Pure and dependency-free so client components can import it directly.
//
// A route behind requireStepUp answers 401 with a machine-readable `error`:
//   "password-required" — this account must enter its password: show the prompt.
//   "invalid-password"  — the password was wrong: keep the prompt, say so.
//   "session-too-old"   — an SSO account must sign in again; `message` says so
//                         and is shown like any other error (no prompt).
export type StepUpNeed = "password" | "retry" | null;

export function stepUpNeedOf(status: number, body: unknown): StepUpNeed {
  if (status !== 401 || typeof body !== "object" || body === null) return null;
  const error = (body as { error?: unknown }).error;
  if (error === "password-required") return "password";
  if (error === "invalid-password") return "retry";
  return null;
}

// The request body to send: the caller's own fields plus the password, when the
// prompt supplied one.
export function withStepUpPassword<T extends object>(body: T, confirmPassword: string | undefined): T & { confirmPassword?: string } {
  return confirmPassword ? { ...body, confirmPassword } : body;
}
